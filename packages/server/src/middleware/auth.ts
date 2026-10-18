import { createMiddleware } from 'hono/factory'
import { and, eq } from 'drizzle-orm'

import { getDb } from '../db/index.js'
import { apiKeys, type ApiKeyRow } from '../db/schema.js'
import { keyPrefixFor, verifyApiKey } from '../auth.js'
import { childLogger } from '../logger.js'

declare module 'hono' {
	interface ContextVariableMap {
		apiKey: ApiKeyRow
	}
}

/** `last_used_at` is refreshed once this much time has passed: one write per key per hour, not per request. */
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000

/**
 * Resolve a raw `mk_live_` key to its active row, or null. Also records that
 * the key is in use, which is what says later whether it can be revoked.
 */
export async function authenticateApiKey(rawKey: string): Promise<ApiKeyRow | null> {
	if (!rawKey) return null
	const db = getDb()
	const rows = await db
		.select()
		.from(apiKeys)
		.where(and(eq(apiKeys.status, 'active'), eq(apiKeys.keyPrefix, keyPrefixFor(rawKey))))
	const matched = rows.find((row) => verifyApiKey(rawKey, row.keyHash))
	if (!matched) return null

	const now = new Date()
	if (!matched.lastUsedAt || now.getTime() - matched.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
		void db
			.update(apiKeys)
			.set({ lastUsedAt: now })
			.where(eq(apiKeys.id, matched.id))
			.catch((err: unknown) => childLogger({ apiKeyId: matched.id, err }).warn('could not record API key use'))
	}
	return matched
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

	const matched = await authenticateApiKey(header.slice(7))
	if (!matched) {
		return c.json({ error: 'Invalid API key' }, 401)
	}

	c.set('apiKey', matched)
	await next()
})
