import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { logger } from 'hono/logger'

import { childLogger } from './logger.js'
import { authMiddleware } from './middleware/auth.js'
import { rateLimitMiddleware } from './middleware/rate-limit.js'
import { calls } from './routes/calls.js'
import { prompts } from './routes/prompts.js'

const app = new Hono()

app.use('*', logger())
app.use('*', cors())

app.get('/health', (c) => c.json({ status: 'ok' }))

const api = new Hono()
api.use('*', authMiddleware)
api.use('*', rateLimitMiddleware)
api.route('/calls', calls)
api.route('/prompts', prompts)

app.route('/api/v1', api)

app.onError((err, c) => {
	// Deliberate HTTP errors keep their status and body.
	if (err instanceof HTTPException) return err.getResponse()
	// Anything else is a bug. The full error (and stack) goes to the log; the
	// client gets a fixed body so query text and internals never leave the server.
	childLogger({ method: c.req.method, path: c.req.path, err }).error('unhandled error')
	return c.json({ error: 'Internal server error' }, 500)
})

export { app }
