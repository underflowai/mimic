/**
 * Job queue configuration.
 *
 * Two queues:
 * - `default` — short jobs (agent compilation, webhooks)
 * - `calls` — long-running voice calls (concurrency limited)
 */

import { Queue, Worker, type Job, type WorkerOptions } from 'bullmq'
import { Redis } from 'ioredis'

function getRedisConnection() {
	const url = process.env.REDIS_URL
	if (!url) throw new Error('REDIS_URL environment variable is required for job queue')
	return new Redis(url, { maxRetriesPerRequest: null })
}

let _connection: Redis | null = null

function connection() {
	if (!_connection) _connection = getRedisConnection()
	return _connection
}

export const callQueue = new Queue('mimic-calls', {
	connection: { lazyConnect: true },
	defaultJobOptions: {
		attempts: 2,
		backoff: { type: 'exponential', delay: 5000 },
		removeOnComplete: { age: 86_400, count: 500 },
		removeOnFail: { age: 3 * 86_400, count: 1000 },
	},
})

callQueue.opts.connection = connection() as never

export interface CallJobData {
	callId: string
	agentId: string
}

export function startCallWorker(
	processor: (job: Job<CallJobData>) => Promise<void>,
	options?: Partial<WorkerOptions>,
): Worker<CallJobData> {
	const worker = new Worker<CallJobData>(
		'mimic-calls',
		processor,
		{
			connection: connection() as never,
			concurrency: options?.concurrency ?? 4,
			lockDuration: 600_000,
			stalledInterval: 60_000,
			...options,
		},
	)

	worker.on('failed', (job, err) => {
		console.error(`[worker] Call job ${job?.id} failed:`, err.message)
	})

	worker.on('completed', (job) => {
		console.log(`[worker] Call job ${job.id} completed`)
	})

	return worker
}

export async function enqueueCall(data: CallJobData) {
	await callQueue.add('call', data, {
		jobId: data.callId,
	})
}

export async function shutdownQueue() {
	await callQueue.close()
	_connection?.disconnect()
}
