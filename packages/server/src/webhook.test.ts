import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'

import { deliverWebhook, signWebhook } from './webhook.js'

function fakeFetch(statuses: number[]) {
	const calls: Array<{ url: string; body: string; signature: string | null }> = []
	const fetchImpl: typeof fetch = async (input, init) => {
		const headers = new Headers(init?.headers)
		calls.push({ url: String(input), body: String(init?.body), signature: headers.get('x-mimic-signature') })
		const status = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 200
		return new Response(null, { status, statusText: status === 200 ? 'OK' : 'Error' })
	}
	return { fetchImpl, calls }
}

describe('deliverWebhook', () => {
	it('signs the body with a timestamp when a secret is set', async () => {
		const { fetchImpl, calls } = fakeFetch([200])
		await deliverWebhook({
			url: 'https://example.com/hook',
			payload: { event: 'call.completed' },
			secret: 's',
			fetchImpl,
		})
		assert.equal(calls.length, 1)
		const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(calls[0]!.signature ?? '')
		assert.ok(match, 'signature header has the t=,v1= form')
		const expected = createHmac('sha256', 's').update(`${match[1]}.${calls[0]!.body}`).digest('hex')
		assert.equal(match[2], expected)
		assert.equal(signWebhook('s', calls[0]!.body, Number(match[1])), calls[0]!.signature)
	})

	it('sends nothing in the signature header without a secret', async () => {
		const { fetchImpl, calls } = fakeFetch([200])
		await deliverWebhook({ url: 'https://example.com/hook', payload: {}, fetchImpl })
		assert.equal(calls[0]!.signature, null)
	})

	it('retries server errors and gives up after the last delay', async () => {
		const { fetchImpl, calls } = fakeFetch([500, 503, 200])
		await deliverWebhook({ url: 'https://example.com/hook', payload: {}, fetchImpl, retryDelaysMs: [1, 1, 1] })
		assert.equal(calls.length, 3)

		const failing = fakeFetch([500])
		await assert.rejects(
			deliverWebhook({
				url: 'https://example.com/hook',
				payload: {},
				fetchImpl: failing.fetchImpl,
				retryDelaysMs: [1],
			}),
			/Webhook delivery failed: 500/,
		)
		assert.equal(failing.calls.length, 2)
	})

	it('does not retry a rejection the endpoint will repeat', async () => {
		const { fetchImpl, calls } = fakeFetch([404])
		await assert.rejects(
			deliverWebhook({ url: 'https://example.com/hook', payload: {}, fetchImpl, retryDelaysMs: [1, 1] }),
			/404/,
		)
		assert.equal(calls.length, 1)
	})
})
