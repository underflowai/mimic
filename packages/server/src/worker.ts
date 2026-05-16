/**
 * Worker process — runs voice calls from the BullMQ queue.
 *
 * Separate from the API server. Each call runs in-process (same as
 * underflowjs). Concurrency limited to 4 calls.
 *
 * Usage:
 *   npx tsx src/worker.ts
 */

import { createServer } from 'node:http'
import { eq } from 'drizzle-orm'
import { Worker } from 'bullmq'
import { Redis } from 'ioredis'

import { logger } from './logger.js'
import { getDb } from './db/index.js'
import { apiAgents, apiCalls } from './db/schema.js'
import { runCall } from './call-runner.js'
import type { CallJobData } from './jobs/queue.js'

function getRedisConnection() {
	const url = process.env.REDIS_URL
	if (!url) throw new Error('REDIS_URL is required')
	return new Redis(url, { maxRetriesPerRequest: null })
}

logger.info({ concurrency: 4 }, 'starting call worker')

const worker = new Worker<CallJobData>(
	'mimic-calls',
	async (job) => {
		const { callId, agentId } = job.data
		logger.info({ callId, agentId, jobId: job.id }, 'processing call')

		const db = getDb()
		const [call] = await db.select().from(apiCalls).where(eq(apiCalls.id, callId)).limit(1)
		const [agent] = await db.select().from(apiAgents).where(eq(apiAgents.id, agentId)).limit(1)

		if (!call || !agent) throw new Error(`Call ${callId} or agent ${agentId} not found`)

		await runCall(call, agent)
	},
	{
		connection: getRedisConnection() as never,
		concurrency: 4,
		lockDuration: 600_000,
		stalledInterval: 60_000,
	},
)

worker.on('failed', (job, err) => {
	logger.error({ callId: job?.data?.callId, jobId: job?.id, err: err.message }, 'call job failed')
})

worker.on('completed', (job) => {
	logger.info({ callId: job.data?.callId, jobId: job.id }, 'call job completed')
})

worker.on('error', (err) => {
	logger.error({ err: err.message }, 'worker error')
})

const healthPort = Number(process.env.HEALTH_PORT) || 3001
const healthServer = createServer((req, res) => {
	if (req.url === '/health') {
		res.writeHead(200, { 'content-type': 'application/json' })
		res.end(JSON.stringify({ status: 'ok', running: worker.isRunning(), pid: process.pid }))
	} else {
		res.writeHead(404)
		res.end()
	}
})
healthServer.listen(healthPort, () => {
	logger.info({ port: healthPort }, 'health check ready')
})

const shutdown = async (signal: string) => {
	logger.info({ signal }, 'shutting down gracefully')
	await Promise.allSettled([
		worker.close(),
		new Promise((resolve) => healthServer.close(resolve)),
	])
	process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
