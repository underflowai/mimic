/**
 * Ends calls that can no longer end on their own.
 *
 * A call is `pending` until a worker picks its job up and `in_progress` until
 * that worker writes the result. If the job never arrived, or the worker
 * holding it died, nothing will ever write a terminal status: the record says
 * the call is live, the stream never closes, the webhook never fires. The
 * queue knows the difference: a job it will still run is waiting or active;
 * a dead call's job is finished or gone. Every minute, calls in that state
 * are failed, their room is torn down in case a phone leg is still up, and
 * the usual end-of-call signals go out.
 */

import { and, eq, inArray, lt } from 'drizzle-orm'
import { RoomServiceClient } from 'livekit-server-sdk'

import { config } from '@mimic/engine'

import { publishCallEvent } from './call-bus.js'
import { notifyCallWebhook } from './call-record.js'
import { getDb } from './db/index.js'
import { apiCalls } from './db/schema.js'
import { getCallJobState } from './jobs/queue.js'
import { childLogger, logger } from './logger.js'
import { callRoomName } from './web-join.js'

const SWEEP_INTERVAL_MS = 60_000
/** The row is written a moment before its job is enqueued; leave fresh calls alone. */
const MIN_AGE_MS = 5 * 60_000
const LIVE_JOB_STATES = new Set(['waiting', 'delayed', 'prioritized', 'active', 'waiting-children'])

export async function sweepDeadCalls(now = new Date()): Promise<string[]> {
	const db = getDb()
	const candidates = await db
		.select({ id: apiCalls.id, status: apiCalls.status })
		.from(apiCalls)
		.where(
			and(
				inArray(apiCalls.status, ['pending', 'in_progress']),
				lt(apiCalls.updatedAt, new Date(now.getTime() - MIN_AGE_MS)),
			),
		)

	const failed: string[] = []
	for (const call of candidates) {
		if (LIVE_JOB_STATES.has(await getCallJobState(call.id))) continue

		const errorMessage = call.status === 'pending' ? 'The call never started' : 'The call ended without a result'
		// Guarded on the status we saw, so a result that lands meanwhile is kept.
		const [row] = await db
			.update(apiCalls)
			.set({ status: 'failed', errorMessage, updatedAt: now })
			.where(and(eq(apiCalls.id, call.id), eq(apiCalls.status, call.status)))
			.returning({ id: apiCalls.id })
		if (!row) continue

		childLogger({ callId: call.id, was: call.status }).warn('failed a call nothing was running')
		if (call.status === 'in_progress') {
			const rooms = new RoomServiceClient(config.livekit.url, config.livekit.apiKey, config.livekit.apiSecret)
			await rooms.deleteRoom(callRoomName(call.id)).catch(() => {})
		}
		publishCallEvent(call.id, { type: 'error', message: errorMessage })
		publishCallEvent(call.id, { type: 'call_status', status: 'failed' })
		await notifyCallWebhook(call.id)
		failed.push(call.id)
	}
	return failed
}

/** Runs the sweep every minute until the returned function is called. */
export function startCallSweeper(): () => void {
	const timer = setInterval(() => {
		sweepDeadCalls().catch((err: unknown) => logger.error({ err }, 'call sweep failed'))
	}, SWEEP_INTERVAL_MS)
	timer.unref()
	return () => clearInterval(timer)
}
