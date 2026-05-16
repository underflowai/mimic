/**
 * In-memory rate limiter per API key.
 *
 * Tracks concurrent calls and requests per minute. Resets counters
 * automatically. No external dependencies.
 */

import { createMiddleware } from 'hono/factory'

interface KeyState {
	activeCalls: number
	requestCount: number
	windowStart: number
}

const state = new Map<string, KeyState>()

const MAX_CONCURRENT_CALLS = 10
const MAX_REQUESTS_PER_MINUTE = 60
const WINDOW_MS = 60_000

function getKeyState(keyId: string): KeyState {
	let s = state.get(keyId)
	const now = Date.now()
	if (!s) {
		s = { activeCalls: 0, requestCount: 0, windowStart: now }
		state.set(keyId, s)
	}
	if (now - s.windowStart > WINDOW_MS) {
		s.requestCount = 0
		s.windowStart = now
	}
	return s
}

export const rateLimitMiddleware = createMiddleware(async (c, next) => {
	const apiKey = c.get('apiKey')
	if (!apiKey) return await next()

	const s = getKeyState(apiKey.id)
	s.requestCount++

	if (s.requestCount > MAX_REQUESTS_PER_MINUTE) {
		return c.json({ error: `Rate limit exceeded. Max ${MAX_REQUESTS_PER_MINUTE} requests per minute.` }, 429)
	}

	await next()
})

export function incrementActiveCalls(keyId: string): boolean {
	const s = getKeyState(keyId)
	if (s.activeCalls >= MAX_CONCURRENT_CALLS) return false
	s.activeCalls++
	return true
}

export function decrementActiveCalls(keyId: string) {
	const s = getKeyState(keyId)
	if (s.activeCalls > 0) s.activeCalls--
}
