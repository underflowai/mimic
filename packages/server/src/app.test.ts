import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { app } from './app.js'

// No DATABASE_URL here: a request that gets past the header check reaches
// getDb() and throws. That is the unexpected-exception path onError exists for.

describe('app.onError', () => {
	it('answers an unexpected exception with a fixed body, not the error message', async () => {
		const res = await app.request('/api/v1/calls/00000000-0000-4000-8000-000000000000', {
			headers: { authorization: 'Bearer mk_live_not_a_real_key' },
		})
		assert.equal(res.status, 500)
		const text = await res.text()
		assert.deepEqual(JSON.parse(text), { error: 'Internal server error' })
		assert.ok(!text.includes('DATABASE_URL'), 'internal error text must not reach the client')
	})

	it('leaves deliberate HTTP responses alone', async () => {
		const res = await app.request('/api/v1/calls/00000000-0000-4000-8000-000000000000')
		assert.equal(res.status, 401)
	})
})

// The auth middleware needs the database, so these exercise the request
// validation through the route handler directly, as the middleware would.
async function postCall(body: Record<string, unknown>) {
	const { calls } = await import('./routes/calls.js')
	const { Hono } = await import('hono')
	const harness = new Hono()
	harness.use('*', async (c, next) => {
		c.set('apiKey' as never, { id: '00000000-0000-4000-8000-000000000000' } as never)
		await next()
	})
	harness.route('/calls', calls)
	const res = await harness.request('/calls', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	const text = await res.text()
	const parsed = res.headers.get('content-type')?.includes('json') ? (JSON.parse(text) as { error?: string }) : {}
	return { status: res.status, body: parsed }
}

describe('POST /calls channel validation', () => {
	it('rejects an unknown channel', async () => {
		const res = await postCall({ channel: 'fax', goal: 'Say hi' })
		assert.equal(res.status, 400)
		assert.match(res.body.error ?? '', /channel must be one of: phone, web/)
	})

	it('still requires a number for phone calls, including by default', async () => {
		for (const body of [
			{ goal: 'Say hi' },
			{ channel: 'phone', goal: 'Say hi' },
			{ channel: 'phone', to: '  ', goal: 'Say hi' },
		]) {
			const res = await postCall(body)
			assert.equal(res.status, 400, JSON.stringify(body))
			assert.match(res.body.error ?? '', /to \(phone number\) is required/)
		}
	})

	it('does not require a number for web calls', async () => {
		// Validation passes; the handler then reaches the database, which this
		// environment does not have. Anything other than the `to` 400 proves the point.
		const res = await postCall({ channel: 'web', goal: 'Say hi' })
		assert.notEqual(res.status, 400)
	})
})
