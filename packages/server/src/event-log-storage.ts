/**
 * Per-call engine event logs, stored beside the recordings.
 *
 * Same bucket and credentials as the LiveKit egress recordings
 * (`RECORDING_S3_*`), under `call-events/<callId>.jsonl`. Nothing here is
 * on the call path: logs are written once at session end and read back by
 * the offline threshold sweeps (`scripts/sweep-thresholds.ts`).
 */

import {
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	type S3ClientConfig,
} from '@aws-sdk/client-s3'

import { parseEventLog, serializeEventLog, type CallEventRecord } from '@mimic/engine'

export const eventLogPrefix = 'call-events/'

export function eventLogKey(callId: string): string {
	return `${eventLogPrefix}${callId}.jsonl`
}

export interface EventLogStorage {
	persist: (callId: string, events: CallEventRecord[]) => Promise<string>
	fetch: (key: string) => Promise<CallEventRecord[]>
	list: (limit?: number) => Promise<string[]>
}

export interface EventLogStorageEnv {
	RECORDING_S3_BUCKET?: string
	RECORDING_S3_ACCESS_KEY?: string
	RECORDING_S3_SECRET?: string
	RECORDING_S3_REGION?: string
	RECORDING_S3_ENDPOINT?: string
}

/** The subset of `S3Client` used here; injectable for tests. */
export type EventLogS3Client = Pick<S3Client, 'send'>

/** Null when `RECORDING_S3_BUCKET` is unset: logs are then only in memory and dropped at session end. */
export function createEventLogStorage(
	env: EventLogStorageEnv = process.env,
	createClient: (config: S3ClientConfig) => EventLogS3Client = (config) => new S3Client(config),
): EventLogStorage | null {
	const bucket = env.RECORDING_S3_BUCKET
	if (!bucket) return null

	const clientConfig: S3ClientConfig = {
		region: env.RECORDING_S3_REGION ?? 'us-east-1',
		credentials:
			env.RECORDING_S3_ACCESS_KEY && env.RECORDING_S3_SECRET
				? { accessKeyId: env.RECORDING_S3_ACCESS_KEY, secretAccessKey: env.RECORDING_S3_SECRET }
				: undefined,
	}
	if (env.RECORDING_S3_ENDPOINT) {
		clientConfig.endpoint = env.RECORDING_S3_ENDPOINT
		// Non-AWS endpoints (R2, MinIO, Tigris) generally want path-style addressing.
		clientConfig.forcePathStyle = true
	}
	const client = createClient(clientConfig)

	return {
		async persist(callId, events) {
			const key = eventLogKey(callId)
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					Body: serializeEventLog(events),
					ContentType: 'application/x-ndjson',
				}),
			)
			return key
		},
		async fetch(key) {
			const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
			const body = await response.Body?.transformToString('utf8')
			return parseEventLog(body ?? '')
		},
		async list(limit = 200) {
			const keys: string[] = []
			let continuationToken: string | undefined
			do {
				const page = await client.send(
					new ListObjectsV2Command({
						Bucket: bucket,
						Prefix: eventLogPrefix,
						ContinuationToken: continuationToken,
						MaxKeys: Math.min(1_000, limit - keys.length),
					}),
				)
				for (const object of page.Contents ?? []) {
					if (object.Key?.endsWith('.jsonl')) keys.push(object.Key)
				}
				continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
			} while (continuationToken && keys.length < limit)
			return keys.slice(0, limit)
		},
	}
}
