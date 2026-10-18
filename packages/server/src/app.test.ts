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
async function callsRequest(path: string, init?: RequestInit) {
	const { calls } = await import('./routes/calls.js')
	const { Hono } = await import('hono')
	const harness = new Hono()
	harness.use('*', async (c, next) => {
		c.set('apiKey' as never, { id: '00000000-0000-4000-8000-000000000000' } as never)
		await next()
	})
	harness.route('/calls', calls)
	const res = await harness.request(path, init)
	const text = await res.text()
	const parsed = res.headers.get('content-type')?.includes('json') ? (JSON.parse(text) as { error?: string }) : {}
	return { status: res.status, body: parsed }
}

async function postCall(body: Record<string, unknown>) {
	return callsRequest('/calls', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
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

	it('requires a goal, from the body or from an owned prompt', async () => {
		let res = await postCall({ to: '+15551234567' })
		assert.equal(res.status, 400)
		assert.match(res.body.error ?? '', /goal is required/)

		// A top-level goal does not stand in for the prompt's own.
		res = await postCall({ to: '+15551234567', goal: 'Say hi', prompt: { systemPrompt: 'You are Casey.' } })
		assert.equal(res.status, 400)
		assert.match(res.body.error ?? '', /prompt\.goal is required/)

		res = await postCall({ to: '+15551234567', prompt: { goal: 'Say hi', systemPrompt: '  ' } })
		assert.equal(res.status, 400)
		assert.match(res.body.error ?? '', /prompt\.systemPrompt must not be empty/)
	})

	it('accepts an owned prompt as far as the database', async () => {
		const res = await postCall({
			to: '+15551234567',
			prompt: { goal: 'Say hi', systemPrompt: 'You are Casey.', turnControlBlock: 'Be brief.', agentName: 'Casey' },
		})
		assert.notEqual(res.status, 400)
	})

	it('does not require a number for web calls', async () => {
		// Validation passes; the handler then reaches the database, which this
		// environment does not have. Anything other than the `to` 400 proves the point.
		const res = await postCall({ channel: 'web', goal: 'Say hi' })
		assert.notEqual(res.status, 400)
	})

	it('only signs webhooks it can send', async () => {
		const res = await postCall({ to: '+15551234567', goal: 'Say hi', webhookSecret: 'whsec_x' })
		assert.equal(res.status, 400)
		assert.match(res.body.error ?? '', /webhookSecret requires webhook/)
	})
})

describe('GET /calls validation', () => {
	it('rejects a bad limit, status, or cursor before touching the database', async () => {
		for (const [query, pattern] of [
			['limit=0', /limit must be an integer between 1 and 100/],
			['limit=101', /limit must be/],
			['limit=ten', /limit must be/],
			['status=done', /status must be one of: pending, in_progress, completed, failed, cancelled/],
			['cursor=not-a-cursor', /cursor is invalid/],
		] as const) {
			const res = await callsRequest(`/calls?${query}`)
			assert.equal(res.status, 400, query)
			assert.match(res.body.error ?? '', pattern)
		}
	})

	it('treats a malformed id as a missing call', async () => {
		const res = await callsRequest('/calls/not-a-uuid')
		assert.equal(res.status, 404)
	})
})
