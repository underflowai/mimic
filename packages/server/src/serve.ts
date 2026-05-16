import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'

import { app } from './app.js'
import { handleStreamUpgrade } from './routes/stream.js'

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: app as never })

app.get(
	'/api/v1/calls/:id/stream',
	upgradeWebSocket((c) => {
		const callId = c.req.param('id') ?? ''
		const token = c.req.query('token') ?? ''
		return handleStreamUpgrade(callId, token)
	}),
)

const port = Number(process.env.PORT) || 3000

const server = serve({ fetch: app.fetch, port }, (info) => {
	console.log(`[server] Listening on http://localhost:${info.port}`)
})

injectWebSocket(server)
