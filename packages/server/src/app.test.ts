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
