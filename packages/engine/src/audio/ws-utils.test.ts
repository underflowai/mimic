import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { awaitWebSocketOpen } from './ws-utils.js'

class MockWebSocket extends EventTarget {
	readyState = WebSocket.CONNECTING
	close() {}

	open() {
		this.readyState = WebSocket.OPEN
		this.dispatchEvent(new Event('open'))
	}
	errorWith(err: Error) {
		// `ErrorEvent` is not globally typed; dispatch a plain Event with
		// the fields `extractWebSocketError` reads structurally.
		const event = Object.assign(new Event('error'), { error: err, message: err.message })
		this.dispatchEvent(event)
	}
	closeWith(code: number, reason = '') {
		this.readyState = WebSocket.CLOSED
		this.dispatchEvent(new CloseEvent('close', { code, reason }))
	}
}

describe('awaitWebSocketOpen', () => {
	it('resolves when open event fires', async () => {
		const ws = new MockWebSocket()
		const promise = awaitWebSocketOpen(ws as never, () => {})
		ws.open()
		await promise
	})

	it('rejects on early error', async () => {
		const ws = new MockWebSocket()
		const promise = awaitWebSocketOpen(ws as never, () => {})
		ws.errorWith(new Error('connection refused'))
		await assert.rejects(promise, { message: 'connection refused' })
	})

	it('rejects on early close', async () => {
		const ws = new MockWebSocket()
		const promise = awaitWebSocketOpen(ws as never, () => {})
		ws.closeWith(1006)
		await assert.rejects(promise, /closed before open/)
	})

	it('rejects on timeout', async () => {
		const ws = new MockWebSocket()
		const promise = awaitWebSocketOpen(ws as never, () => {}, 50)
		await assert.rejects(promise, /did not open within/)
	})

	it('installs persistent error handler after open', async () => {
		const ws = new MockWebSocket()
		const errors: Error[] = []
		const promise = awaitWebSocketOpen(ws as never, (err) => errors.push(err))
		ws.open()
		await promise
		ws.errorWith(new Error('late error'))
		assert.equal(errors.length, 1)
		assert.equal(errors[0].message, 'late error')
	})

	it('suppresses error events fired during teardown (readyState !== OPEN)', async () => {
		// undici emits a spurious error event from its internal
		// `#onSocketClose` during normal teardown; by then readyState has
		// already transitioned to CLOSING/CLOSED. Those are noise and
		// should not reach the persistent error handler.
		const ws = new MockWebSocket()
		const errors: Error[] = []
		const promise = awaitWebSocketOpen(ws as never, (err) => errors.push(err))
		ws.open()
		await promise
		ws.readyState = WebSocket.CLOSED
		ws.errorWith(new Error('teardown noise'))
		assert.equal(errors.length, 0, 'teardown errors should be suppressed')
	})
})
