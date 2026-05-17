import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { eq } from 'drizzle-orm'

import { app } from './app.js'
import { runCall } from './call-runner.js'
import { getDb } from './db/index.js'
import { apiAgents, apiCalls } from './db/schema.js'
import { logger } from './logger.js'
import { startCallWorker } from './jobs/queue.js'
import { handleStreamUpgrade } from './routes/stream.js'

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: app as never })

app.get(
	'/api/v1/calls/:id/stream',
	upgradeWebSocket((c) => {
		const callId = c.req.param('id') ?? ''
		return handleStreamUpgrade(callId)
	}),
)

const port = Number(process.env.PORT) || 3000

const server = serve({ fetch: app.fetch, port }, (info) => {
	console.log(`[server] Listening on http://localhost:${info.port}`)
})

injectWebSocket(server)

const inProcessWorkerEnabled = process.env.MIMIC_DISABLE_IN_PROCESS_WORKER !== '1'
const workerConcurrency = Number(process.env.WORKER_CONCURRENCY || 4)

const worker = inProcessWorkerEnabled
	? startCallWorker(
			async (job) => {
				const { callId, agentId } = job.data
				const db = getDb()
				const [call] = await db.select().from(apiCalls).where(eq(apiCalls.id, callId)).limit(1)
				const [agent] = await db.select().from(apiAgents).where(eq(apiAgents.id, agentId)).limit(1)
				if (!call || !agent) {
					throw new Error(`Call ${callId} or agent ${agentId} not found`)
				}
				await runCall(call, agent)
			},
			{ concurrency: workerConcurrency },
		)
	: null

if (worker) {
	logger.info({ concurrency: workerConcurrency }, 'in-process call worker enabled')
}

const shutdown = async (signal: string) => {
	logger.info({ signal }, 'shutting down server')
	await worker?.close().catch((err) => logger.error({ err }, 'failed to close worker'))
	server.close(() => process.exit(0))
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
