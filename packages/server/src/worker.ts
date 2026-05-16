/**
 * Worker process — runs voice calls from the BullMQ queue.
 *
 * Each call runs in a forked child process (BullMQ sandboxed processor).
 * A crash in one call only kills that child — other active calls and
 * the worker supervisor are unaffected.
 *
 * Usage:
 *   npx tsx src/worker.ts
 */

import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'bullmq'
import { Redis } from 'ioredis'

const __dirname = dirname(fileURLToPath(import.meta.url))
const processorPath = join(__dirname, 'jobs/call-processor.ts')

function getRedisConnection() {
	const url = process.env.REDIS_URL
	if (!url) throw new Error('REDIS_URL is required')
	return new Redis(url, { maxRetriesPerRequest: null })
}

import { logger } from './logger.js'

logger.info({ processorPath, concurrency: 4 }, 'starting sandboxed call worker')

const worker = new Worker(
	'mimic-calls',
	processorPath,
	{
		connection: getRedisConnection() as never,
		concurrency: 4,
		lockDuration: 600_000,
		stalledInterval: 60_000,
		useWorkerThreads: false,
	},
)

worker.on('failed', (job, err) => {
	console.error(`[worker] Call ${job?.data?.callId ?? job?.id} failed (pid will be recycled):`, err.message)
})

worker.on('completed', (job) => {
	console.log(`[worker] Call ${job.data?.callId ?? job.id} completed`)
})

worker.on('error', (err) => {
	console.error('[worker] Worker error:', err.message)
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
	console.log(`[worker] Health check on http://localhost:${healthPort}/health`)
})

const shutdown = async (signal: string) => {
	console.log(`[worker] Received ${signal}, shutting down gracefully...`)
	await Promise.allSettled([
		worker.close(),
		new Promise((resolve) => healthServer.close(resolve)),
	])
	process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
