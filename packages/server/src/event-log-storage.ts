/**
 * Event-log persistence — JSONL per call, stored in the same S3 bucket
 * as recordings (`call-events/<callId>.jsonl` beside
 * `call-recordings/<callId>.ogg`).
 *
 * Uses the RECORDING_S3_* environment that already configures LiveKit
 * egress. When the bucket is not configured, persistence is skipped —
 * the log still exists in memory for the duration of the call.
 */

import { PutObjectCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

import { serializeEventLog, type CallEventRecord } from '@mimic/engine'

import { childLogger } from './logger.js'

export function eventLogStorageConfigured(): boolean {
	return Boolean(process.env.RECORDING_S3_BUCKET)
}

let client: S3Client | null = null

function getClient(): S3Client {
	if (!client) {
		client = new S3Client({
			region: process.env.RECORDING_S3_REGION ?? 'us-east-1',
			...(process.env.RECORDING_S3_ENDPOINT ? { endpoint: process.env.RECORDING_S3_ENDPOINT } : {}),
			credentials: {
				accessKeyId: process.env.RECORDING_S3_ACCESS_KEY ?? '',
				secretAccessKey: process.env.RECORDING_S3_SECRET ?? '',
			},
		})
	}
	return client
}

export function eventLogKey(callId: string): string {
	return `call-events/${callId}.jsonl`
}

/** Upload a call's event log. Returns the object key, or null when skipped/failed. */
export async function persistCallEventLog(callId: string, events: CallEventRecord[]): Promise<string | null> {
	if (!eventLogStorageConfigured()) return null
	if (events.length === 0) return null

	const key = eventLogKey(callId)
	try {
		await getClient().send(
			new PutObjectCommand({
				Bucket: process.env.RECORDING_S3_BUCKET!,
				Key: key,
				Body: serializeEventLog(events),
				ContentType: 'application/x-ndjson',
			}),
		)
		childLogger({ callId, key, events: events.length }).info('persisted call event log')
		return key
	} catch (err) {
		childLogger({ callId, err: err instanceof Error ? err.message : String(err) }).error(
			'failed to persist call event log',
		)
		return null
	}
}

/** Download one event log as raw JSONL. */
export async function fetchCallEventLog(key: string): Promise<string | null> {
	if (!eventLogStorageConfigured()) return null
	try {
		const response = await getClient().send(
			new GetObjectCommand({ Bucket: process.env.RECORDING_S3_BUCKET!, Key: key }),
		)
		return (await response.Body?.transformToString()) ?? null
	} catch {
		return null
	}
}

/** List persisted event-log keys (for corpus sweeps). */
export async function listCallEventLogs(limit = 1000): Promise<string[]> {
	if (!eventLogStorageConfigured()) return []
	const keys: string[] = []
	let continuationToken: string | undefined
	do {
		const response = await getClient().send(
			new ListObjectsV2Command({
				Bucket: process.env.RECORDING_S3_BUCKET!,
				Prefix: 'call-events/',
				ContinuationToken: continuationToken,
			}),
		)
		for (const item of response.Contents ?? []) {
			if (item.Key?.endsWith('.jsonl')) keys.push(item.Key)
			if (keys.length >= limit) return keys
		}
		continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
	} while (continuationToken)
	return keys
}
