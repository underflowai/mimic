import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isAbortLikeError, safeInvoke, withTimeout } from './async-utils.js'

describe('async-utils', () => {
	it('withTimeout resolves successful operation', async () => {
		const result = await withTimeout(Promise.resolve('ok'), 50)
		assert.equal(result, 'ok')
	})

	it('withTimeout rejects with timeout error and invokes onTimeout', async () => {
		let timedOut = false
		await assert.rejects(
			() =>
				withTimeout(new Promise<void>(() => {}), 10, {
					message: 'custom timeout',
					onTimeout: () => {
						timedOut = true
					},
				}),
			/custom timeout/,
		)
		assert.equal(timedOut, true)
	})

	it('withTimeout rejects on abort signal', async () => {
		const abortController = new AbortController()
		abortController.abort()
		await assert.rejects(
			() => withTimeout(Promise.resolve('never'), 100, { signal: abortController.signal }),
			(err: unknown) => err instanceof DOMException && err.name === 'AbortError',
		)
	})

	it('isAbortLikeError recognizes common abort shapes', () => {
		assert.equal(isAbortLikeError(new DOMException('aborted', 'AbortError')), true)
		assert.equal(isAbortLikeError(new Error('request aborted')), true)
		assert.equal(isAbortLikeError({ code: 'ABORT_ERR' }), true)
		assert.equal(isAbortLikeError({ code: 'ERR_ABORTED' }), true)
		assert.equal(isAbortLikeError(new Error('other failure')), false)
	})

	it('safeInvoke returns callback result and traps callback errors', () => {
		assert.equal(
			safeInvoke(
				() => 42,
				() => {},
			),
			42,
		)
		let caughtMessage = ''
		const value = safeInvoke(
			() => {
				throw new Error('callback failed')
			},
			(err) => {
				caughtMessage = err.message
			},
		)
		assert.equal(value, undefined)
		assert.equal(caughtMessage, 'callback failed')
	})
})
