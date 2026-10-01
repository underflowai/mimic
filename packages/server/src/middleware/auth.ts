import { createMiddleware } from 'hono/factory'
import { and, eq } from 'drizzle-orm'

import { getDb } from '../db/index.js'
import { apiKeys, type ApiKeyRow } from '../db/schema.js'
import { keyPrefixFor, verifyApiKey } from '../auth.js'

declare module 'hono' {
	interface ContextVariableMap {
		apiKey: ApiKeyRow
	}
}

export const authMiddleware = createMiddleware(async (c, next) => {
	// WebSocket upgrades (the call stream) authenticate themselves: browsers and
	// the SDK can't set headers on `new WebSocket(url)`, so the stream route
	// accepts a first-frame `{ type: 'auth', token }` and closes on timeout.
	if (c.req.header('upgrade')?.toLowerCase() === 'websocket') {
		return await next()
	}

	const header = c.req.header('authorization')
	if (!header?.startsWith('Bearer ')) {
		return c.json({ error: 'Missing or malformed Authorization header' }, 401)
	}

	const rawKey = header.slice(7)
	if (!rawKey) {
		return c.json({ error: 'Invalid API key' }, 401)
	}
	const db = getDb()
	const prefix = keyPrefixFor(rawKey)

	const rows = await db
		.select()
		.from(apiKeys)
		.where(and(eq(apiKeys.status, 'active'), eq(apiKeys.keyPrefix, prefix)))
	const matched = rows.find((row) => verifyApiKey(rawKey, row.keyHash))

	if (!matched) {
		return c.json({ error: 'Invalid API key' }, 401)
	}

	c.set('apiKey', matched)
	await next()
})
