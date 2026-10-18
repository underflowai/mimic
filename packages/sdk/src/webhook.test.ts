import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'

import { verifyWebhook } from './webhook.js'

const secret = 'whsec_test'
const payload = JSON.stringify({ event: 'call.completed', call: { id: 'call_1' } })

/** What the server does in `signWebhook`. */
function sign(body: string, t: number, key = secret) {
	return `t=${t},v1=${createHmac('sha256', key).update(`${t}.${body}`).digest('hex')}`
}

describe('verifyWebhook', () => {
	it('accepts a fresh signature over the raw body', async () => {
		const t = Math.floor(Date.now() / 1000)
		assert.equal(await verifyWebhook({ payload, signature: sign(payload, t), secret }), true)
	})

	it('rejects a different secret, a changed body, and a stale timestamp', async () => {
		const t = Math.floor(Date.now() / 1000)
		assert.equal(await verifyWebhook({ payload, signature: sign(payload, t, 'other'), secret }), false)
		assert.equal(await verifyWebhook({ payload: payload + ' ', signature: sign(payload, t), secret }), false)
		assert.equal(await verifyWebhook({ payload, signature: sign(payload, t - 600), secret }), false)
		assert.equal(
			await verifyWebhook({ payload, signature: sign(payload, t - 600), secret, toleranceSeconds: 900 }),
			true,
		)
	})

	it('rejects a missing or malformed header', async () => {
		assert.equal(await verifyWebhook({ payload, signature: undefined, secret }), false)
		assert.equal(await verifyWebhook({ payload, signature: 'v1=abc', secret }), false)
		assert.equal(await verifyWebhook({ payload, signature: 't=1,v1=abc', secret }), false)
	})
})
