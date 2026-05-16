import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { flushImmediate, sleepMs } from '#test/support/async.js'
import { AutoOpenMockSocket } from '#test/support/mock-websocket.js'
import { createMockTtsSessionHarness } from '#test/support/tts-session-fixture.js'

class MockSocket extends AutoOpenMockSocket {
	constructor(openDelayMs = 0) {
		super({ openDelayMs })
	}

	send(_data: string | Buffer) {}
}

function createTestSession() {
	return createMockTtsSessionHarness(() => new MockSocket())
}

function createSlowOpenSession(openDelayMs: number) {
	return createMockTtsSessionHarness(() => new MockSocket(openDelayMs))
}

describe('createTtsSocketSession', () => {
	it('opens a socket on connect', async () => {
		const { session, sockets } = createTestSession()
		await session.connect()
		assert.equal(sockets.length, 1)
		assert.equal(sockets[0].readyState, WebSocket.OPEN)
	})

	it('connect is idempotent', async () => {
		const { session, sockets } = createTestSession()
		await session.connect()
		await session.connect()
		assert.equal(sockets.length, 1)
	})

	it('acquireSocket returns the open socket', async () => {
		const { session, sockets } = createTestSession()
		await session.connect()
		const ws = await session.acquireSocket()
		assert.equal(ws, sockets[0] as unknown as WebSocket)
	})

	it('acquireSocket reconnects after socket drops', async () => {
		const { session, sockets } = createTestSession()
		await session.connect()
		sockets[0].close()
		await flushImmediate()
		const ws = await session.acquireSocket()
		assert.equal(sockets.length, 2)
		assert.equal(ws, sockets[1] as unknown as WebSocket)
	})

	it('interrupt while idle is a no-op (socket survives)', async () => {
		const { session, sockets } = createTestSession()
		await session.connect()
		session.interrupt()
		assert.equal(sockets[0].readyState, WebSocket.OPEN, 'socket should survive')
	})

	it('interrupt while synthesizing aborts and sends cancel', async () => {
		const { session, sockets } = createTestSession()
		await session.connect()

		let aborted = false
		const sent: string[] = []
		sockets[0].send = (data: string | Buffer) => {
			sent.push(String(data))
		}
		session.markSynthesisStart('ctx-1', () => {
			aborted = true
		})
		session.interrupt()

		assert.ok(aborted, 'should have aborted active synthesis')
		const cancelMsg = sent.find((s) => {
			try {
				const p = JSON.parse(s)
				return p.cancel === true && p.context_id === 'ctx-1'
			} catch {
				return false
			}
		})
		assert.ok(cancelMsg, 'should have sent cancel message')
		assert.equal(sockets[0].readyState, WebSocket.OPEN, 'socket should stay open after cancel')
	})

	it('double interrupt is harmless', async () => {
		const { session, sockets } = createTestSession()
		await session.connect()

		let abortCount = 0
		session.markSynthesisStart('ctx-1', () => abortCount++)
		session.interrupt()
		session.interrupt()

		assert.equal(abortCount, 1, 'should only abort once')
		assert.equal(sockets[0].readyState, WebSocket.OPEN)
	})

	it('isIdle tracks synthesis lifecycle', async () => {
		const { session } = createTestSession()
		await session.connect()

		assert.ok(session.isIdle(), 'should be idle initially')
		session.markSynthesisStart('ctx-1', () => {})
		assert.ok(!session.isIdle(), 'should not be idle during synthesis')
		session.markSynthesisEnd()
		assert.ok(session.isIdle(), 'should be idle after synthesis ends')
	})

	it('shutdown closes socket', async () => {
		const { session, sockets } = createTestSession()
		await session.connect()
		session.shutdown()
		assert.equal(sockets[0].readyState, WebSocket.CLOSED)
	})

	it('acquireSocket throws after shutdown', async () => {
		const { session } = createTestSession()
		await session.connect()
		session.shutdown()
		await assert.rejects(() => session.acquireSocket(), /TTS session closed/)
	})

	it('shutdown during opening closes the session', async () => {
		const { session, sockets } = createSlowOpenSession(30)
		const connectPromise = session.connect()
		session.shutdown()
		await connectPromise.catch(() => {})
		await sleepMs(100)
		assert.equal(sockets.length, 1, 'connect should only create one socket')
		await assert.rejects(() => session.acquireSocket(), /TTS session closed/)
	})
})
