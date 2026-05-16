/**
 * Worker process — runs voice calls from the BullMQ queue.
 *
 * Separate from the API server. Deploy as a second container/process.
 *
 * Usage:
 *   npx tsx src/worker.ts
 */

import { eq } from 'drizzle-orm'

import { getDb } from './db/index.js'
import { apiAgents, apiCalls } from './db/schema.js'
import { runCall } from './call-runner.js'
import { startCallWorker, type CallJobData } from './jobs/queue.js'

console.log('[worker] Starting call worker')

const worker = startCallWorker(async (job) => {
	const { callId, agentId } = job.data as CallJobData
	console.log(`[worker] Processing call ${callId}`)

	const db = getDb()
	const [call] = await db.select().from(apiCalls).where(eq(apiCalls.id, callId)).limit(1)
	const [agent] = await db.select().from(apiAgents).where(eq(apiAgents.id, agentId)).limit(1)

	if (!call || !agent) {
		throw new Error(`Call ${callId} or agent ${agentId} not found`)
	}

	await runCall(call, agent)
})

const shutdown = async (signal: string) => {
	console.log(`[worker] Received ${signal}, shutting down gracefully...`)
	await worker.close()
	process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
