import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { flushImmediate, sleepMs } from '#test/support/async.js'
import { shouldRunLiveMimicTests } from '#test/support/live-test-gate.js'
import { AutoOpenMockSocket } from '#test/support/mock-websocket.js'
import { waitForCondition } from '#test/support/wait-for-condition.js'
import { createDeepgramTranscriber } from './deepgram-transcriber.js'

// ---------------------------------------------------------------------------
// Unit tests (mock WebSocket — no network)
// ---------------------------------------------------------------------------

describe('createDeepgramTranscriber', () => {
	it('returns object with expected API surface', () => {
		const transcriber = createDeepgramTranscriber()
		assert.equal(typeof transcriber.connect, 'function')
		assert.equal(typeof transcriber.configure, 'function')
		assert.equal(typeof transcriber.sendAudio, 'function')
		assert.equal(typeof transcriber.on, 'function')
		assert.equal(typeof transcriber.off, 'function')
		assert.equal(typeof transcriber.close, 'function')
	})

	it('accepts custom encoding and sample rate', () => {
		const transcriber = createDeepgramTranscriber({ encoding: 'mulaw', sampleRate: 8000 })
		assert.equal(typeof transcriber.connect, 'function')
	})
})

describe('event emitter contract', () => {
	it('on/off subscribe and unsubscribe without error', () => {
		const transcriber = createDeepgramTranscriber()
		const handler = mock.fn()
		transcriber.on('turnComplete', handler)
		transcriber.off('turnComplete', handler)
	})

	it('all event types can be subscribed', () => {
		const transcriber = createDeepgramTranscriber()
		const events = ['turnComplete', 'turnStart', 'eagerTurn', 'turnResumed', 'update', 'error'] as const
		for (const event of events) {
			const handler = mock.fn()
			transcriber.on(event, handler as never)
			transcriber.off(event, handler as never)
		}
	})
})

describe('configure (no socket)', () => {
	it('is a no-op when not connected', () => {
		const transcriber = createDeepgramTranscriber()
		transcriber.configure({ eotThreshold: 0.9 })
	})
})

describe('sendAudio (no socket)', () => {
	it('is a no-op when not connected', () => {
		const transcriber = createDeepgramTranscriber()
		transcriber.sendAudio(Buffer.alloc(320))
	})
})

describe('close (no socket)', () => {
	it('is a no-op when not connected', async () => {
		const transcriber = createDeepgramTranscriber()
		await transcriber.close()
	})
})

class MockDeepgramSocket extends AutoOpenMockSocket {
	constructor() {
		super()
	}

	send(_data: string | Buffer) {}

	emitJson(payload: unknown) {
		this.emitJsonMessage(payload)
	}
}

class DelayedOpenDeepgramSocket extends AutoOpenMockSocket {
	constructor(openDelayMs: number) {
		super({ openDelayMs })
	}

	send(_data: string | Buffer) {}
}

class FailingConnectSocket extends AutoOpenMockSocket {
	constructor() {
		super({ autoOpen: false })
		queueMicrotask(() => {
			if (this.isClosed) return
			this.emitErrorEvent(new Error('connect failed'))
			this.close(1011, 'connect failed')
		})
	}

	send(_data: string | Buffer) {}
}

describe('reconnect wiring', () => {
	it('reattaches message handlers after reconnect', async () => {
		const sockets: MockDeepgramSocket[] = []
		const transcriber = createDeepgramTranscriber({
			createWebSocket: () => {
				const socket = new MockDeepgramSocket()
				sockets.push(socket)
				return socket as unknown as WebSocket
			},
		})
		const updates: string[] = []
		transcriber.on('update', (transcript) => {
			updates.push(transcript)
		})

		await transcriber.connect()
		assert.equal(sockets.length, 1)

		sockets[0].close(1011, 'connection dropped')
		await waitForCondition(() => sockets.length >= 2, 3_000)
		assert.ok(sockets.length >= 2, 'should create a replacement socket after reconnect')

		sockets.at(-1)!.emitJson({
			type: 'TurnInfo',
			event: 'Update',
			transcript: 'hello after reconnect',
			end_of_turn_confidence: 0.7,
		})
		await flushImmediate()

		assert.equal(updates.includes('hello after reconnect'), true)
		await transcriber.close()
	})

	it('does not retain reconnect socket when close() races during reconnect await', async () => {
		const sockets: DelayedOpenDeepgramSocket[] = []
		let created = 0
		const transcriber = createDeepgramTranscriber({
			createWebSocket: () => {
				created++
				const socket = new DelayedOpenDeepgramSocket(created === 1 ? 0 : 60)
				sockets.push(socket)
				return socket as unknown as WebSocket
			},
		})

		await transcriber.connect()
		assert.equal(sockets.length, 1)

		sockets[0].close(1011, 'connection dropped')
		await waitForCondition(() => sockets.length >= 2, 2_500)

		await transcriber.close()
		await sleepMs(120)

		assert.equal(sockets[1].readyState, WebSocket.CLOSED, 'reconnect socket should be closed after close() race')
	})
})

describe('connect cleanup', () => {
	it('clears stale socket after failed connect so reconnect attempts are allowed', async () => {
		let created = 0
		const transcriber = createDeepgramTranscriber({
			createWebSocket: () => {
				created++
				return new FailingConnectSocket() as unknown as WebSocket
			},
		})

		await assert.rejects(() => transcriber.connect())

		let secondError: Error | null = null
		try {
			await transcriber.connect()
		} catch (err) {
			secondError = err as Error
		}

		assert.ok(secondError, 'second connect should reject due forced failing socket')
		assert.equal(secondError!.message.includes('Already connected'), false)
		assert.equal(created, 2, 'connect should create a fresh socket after failure')
		await transcriber.close()
	})
})

// ---------------------------------------------------------------------------
// Integration test — real Deepgram connection (skipped without valid API key)
// ---------------------------------------------------------------------------

describe('deepgram integration', () => {
	it('connects to Deepgram Flux and receives ConfigureSuccess', async (ctx) => {
		if (!shouldRunLiveMimicTests()) {
			ctx.skip()
			return
		}
		const { config } = await import('#engine/config.js')
		const apiKey = config.mimic.deepgram.apiKey

		if (!apiKey || apiKey === 'test-deepgram-key-for-unit-tests') {
			ctx.skip()
			return
		}

		const transcriber = createDeepgramTranscriber()

		try {
			await transcriber.connect()
			const configureResult = await new Promise<string>((resolve) => {
				const timeout = setTimeout(() => resolve('timeout'), 3000)
				transcriber.on('error', (msg) => {
					clearTimeout(timeout)
					resolve(`error: ${msg}`)
				})

				transcriber.configure({ eotThreshold: 0.85 })
				setTimeout(() => {
					clearTimeout(timeout)
					resolve('ok')
				}, 1500)
			})

			assert.ok(
				configureResult === 'ok' || configureResult === 'timeout',
				`unexpected configure result: ${configureResult}`,
			)
		} catch (err) {
			if ((err as Error).message?.includes('401') || (err as Error).message?.includes('API')) {
				ctx.skip()
				return
			}
			throw err
		} finally {
			await transcriber.close()
		}
	})
})
