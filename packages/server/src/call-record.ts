/**
 * The one shape a call has outside the database: `GET /calls/:id`, each item of
 * `GET /calls`, and the `call` inside every webhook. The SDK's `Call` type is this.
 */

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { eq } from 'drizzle-orm'

import { getDb } from './db/index.js'
import { apiCalls, type ApiCallRow } from './db/schema.js'
import { recordingS3ClientConfig } from './event-log-storage.js'
import { childLogger } from './logger.js'
import { deliverWebhook } from './webhook.js'

/** How long a recording link works. Fetch the call again for a fresh one. */
export const RECORDING_URL_TTL_SECONDS = 3600

export interface CallRecord {
	id: string
	status: ApiCallRow['status']
	channel: ApiCallRow['channel']
	/** E.164 number dialed; null for web calls. */
	to: string | null
	createdAt: string
	/** Seconds on the call; null until it ends. */
	duration: number | null
	goalAchieved: boolean | null
	goalAchievedReason: string | null
	/** The `extract` fields, filled in after the call. Unknown values are null. */
	data: Record<string, unknown> | null
	transcript: Array<{ role: 'agent' | 'caller'; content: string }>
	toolCalls: Array<{ name: string; input: unknown; output: unknown; success?: boolean }>
	error: string | null
	/** Signed link to the recording, good for {@link RECORDING_URL_TTL_SECONDS}; null when there is none. */
	recordingUrl: string | null
}

let s3: S3Client | null = null

async function recordingUrl(key: string): Promise<string | null> {
	const bucket = process.env.RECORDING_S3_BUCKET
	if (!bucket) return null
	s3 ??= new S3Client(recordingS3ClientConfig())
	return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: RECORDING_URL_TTL_SECONDS })
}

/**
 * POST the call to its webhook once it has ended, if it has one. The payload's
 * `call` is exactly what `GET /calls/:id` returns at that moment. Failures are
 * logged, never thrown: the call's own outcome is already recorded.
 */
export async function notifyCallWebhook(callId: string) {
	const db = getDb()
	const [row] = await db.select().from(apiCalls).where(eq(apiCalls.id, callId)).limit(1)
	if (!row?.webhookUrl) return
	try {
		await deliverWebhook({
			url: row.webhookUrl,
			secret: row.webhookSecret,
			payload: { event: row.status === 'completed' ? 'call.completed' : 'call.failed', call: await toCallRecord(row) },
		})
		await db.update(apiCalls).set({ webhookDeliveredAt: new Date() }).where(eq(apiCalls.id, callId))
	} catch (err) {
		childLogger({ callId, err }).error('webhook delivery failed')
	}
}

export async function toCallRecord(row: ApiCallRow): Promise<CallRecord> {
	return {
		id: row.id,
		status: row.status,
		channel: row.channel,
		to: row.toPhone,
		createdAt: row.createdAt.toISOString(),
		duration: row.duration,
		goalAchieved: row.goalAchieved,
		goalAchievedReason: row.goalAchievedReason,
		data: (row.result as CallRecord['data']) ?? null,
		transcript: (row.transcript as CallRecord['transcript']) ?? [],
		toolCalls: (row.toolCalls as CallRecord['toolCalls']) ?? [],
		error: row.errorMessage,
		recordingUrl: row.recordingPath ? await recordingUrl(row.recordingPath) : null,
	}
}
