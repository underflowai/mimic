import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import { authMiddleware } from './middleware/auth.js'
import { calls } from './routes/calls.js'

const app = new Hono()

app.use('*', logger())
app.use('*', cors())

app.get('/health', (c) => c.json({ status: 'ok' }))

const api = new Hono()
api.use('*', authMiddleware)
api.route('/calls', calls)

app.route('/api/v1', api)

app.onError((err, c) => {
	console.error('[server] Unhandled error:', err)
	return c.json({ error: err.message ?? 'Internal server error' }, 500)
})

export { app }
