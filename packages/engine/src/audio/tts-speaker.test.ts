import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { flushImmediate } from '#test/support/async.js'
import { AutoOpenMockSocket } from '#test/support/mock-websocket.js'
import { createMockTtsSessionHarness } from '#test/support/tts-session-fixture.js'
import { createTtsSpeaker } from './tts-speaker.js'

/** Must match pcmFrameBytes in tts-speaker (48kHz s16le mono, 20ms). */
const pcmFrameBytes = 48000 * 2 * 0.02

type MockScenario = 'ok' | 'error' | 'delayed'

class MockCartesiaTtsSocket extends AutoOpenMockSocket {
	sent: string[] = []

	constructor(private readonly scenario: MockScenario) {
		super()
	}

	send(data: string | Buffer) {
		if (this.isClosed) return
		this.sent.push(String(data))
		const p = JSON.parse(String(data)) as Record<string, unknown>
		const contextId = typeof p.context_id === 'string' ? p.context_id : undefined

		if (p.cancel) return

		const isFinal = p.continue === false
		if (!isFinal) return

		if (this.scenario === 'ok') {
			const frame = Buffer.alloc(pcmFrameBytes, 9)
			queueMicrotask(() => {
				if (!this.isOpen) return
				this.emitJsonMessage({
					type: 'chunk',
					data: frame.toString('base64'),
					done: false,
					status_code: 206,
					step_time: 10,
					context_id: contextId,
				})
				queueMicrotask(() => {
					if (!this.isOpen) return
					this.emitJsonMessage({
						type: 'done',
						done: true,
						status_code: 200,
						context_id: contextId,
					})
				})
			})
		}

		if (this.scenario === 'error') {
			queueMicrotask(() => {
				if (this.isClosed) return
				this.emitJsonMessage({
					type: 'error',
					message: 'synthetic failure',
					status_code: 500,
					context_id: contextId,
				})
			})
		}

		if (this.scenario === 'delayed') {
			setTimeout(() => {
				if (!this.isOpen) return
				const frame = Buffer.alloc(pcmFrameBytes, 3)
				this.emitJsonMessage({
					type: 'chunk',
					data: frame.toString('base64'),
					done: false,
					status_code: 206,
					step_time: 10,
					context_id: contextId,
				})
				this.emitJsonMessage({
					type: 'done',
					done: true,
					status_code: 200,
					context_id: contextId,
				})
			}, 80)
		}
	}
}

function createTestSpeaker(scenario: MockScenario = 'ok') {
	const { session, sockets } = createMockTtsSessionHarness(() => new MockCartesiaTtsSocket(scenario))
	const speaker = createTtsSpeaker({ session })
	return { speaker, sockets }
}

describe('preSendTextForSynthesis', () => {
	it('sends text with continue:true immediately and continue:false on trigger', async () => {
		const { speaker, sockets } = createTestSpeaker('ok')
		await speaker.connect()
		const sentBefore = sockets[0].sent.length

		const chunks: Buffer[] = []
		const handle = await speaker.preSendTextForSynthesis('Hello there.', (c) => chunks.push(c))

		const newSent = sockets[0].sent.slice(sentBefore)
		const hasInitialSend = newSent.some((s) => {
			const p = JSON.parse(s)
			return p.transcript === 'Hello there.' && p.continue === true
		})
		assert.ok(hasInitialSend, 'should send text with continue:true immediately')

		handle.triggerSynthesisStart()
		await handle.audioComplete

		const allNewSent = sockets[0].sent.slice(sentBefore)
		assert.ok(
			allNewSent.some((s) => {
				const p = JSON.parse(s)
				return p.continue === false
			}),
			'should send continue:false after trigger',
		)
		assert.ok(chunks.length >= 1, 'should deliver audio chunks')
		assert.equal(chunks[0].length, pcmFrameBytes)
	})

	it('pushTextDelta sends additional continuation messages before trigger', async () => {
		const { speaker, sockets } = createTestSpeaker('ok')
		await speaker.connect()
		const sentBefore = sockets[0].sent.length

		const handle = await speaker.preSendTextForSynthesis('First part. ', () => {})
		handle.pushTextDelta('Second part.')
		handle.triggerSynthesisStart()
		await handle.audioComplete

		const continuations = sockets[0].sent.slice(sentBefore).filter((s) => {
			const p = JSON.parse(s)
			return p.transcript && p.continue === true
		})
		assert.equal(continuations.length, 2, 'should send two continuation messages')
	})

	it('rejects audioComplete on server error', async () => {
		const { speaker } = createTestSpeaker('error')
		await speaker.connect()

		const handle = await speaker.preSendTextForSynthesis('fail', () => {})
		handle.triggerSynthesisStart()
		await assert.rejects(handle.audioComplete, /synthetic failure/)
	})

	it('resolves audioComplete on interrupt', async () => {
		const { speaker } = createTestSpeaker('delayed')
		await speaker.connect()

		const handle = await speaker.preSendTextForSynthesis('wait', () => {})
		handle.triggerSynthesisStart()
		await flushImmediate()
		speaker.interrupt()
		await handle.audioComplete
	})

	it('second pre-send supersedes the first via epoch bump', async () => {
		const { speaker } = createTestSpeaker('ok')
		await speaker.connect()

		const firstHandle = await speaker.preSendTextForSynthesis('occupying socket', () => {})
		const secondHandle = await speaker.preSendTextForSynthesis('supersedes first', () => {})
		secondHandle.triggerSynthesisStart()
		await secondHandle.audioComplete
		await firstHandle.audioComplete
	})

	it('synthesis works after previous pre-send completes', async () => {
		const { speaker } = createTestSpeaker('ok')
		await speaker.connect()

		const handle = await speaker.preSendTextForSynthesis('first', () => {})
		handle.triggerSynthesisStart()
		await handle.audioComplete

		const chunks: Buffer[] = []
		const handle2 = await speaker.preSendTextForSynthesis('second works', (c: Buffer) => chunks.push(c))
		handle2.triggerSynthesisStart()
		await handle2.audioComplete
		assert.ok(chunks.length >= 1, 'should be able to synthesize after pre-send completes')
	})

	it('returns no-op handle for empty text', async () => {
		const { speaker, sockets } = createTestSpeaker('ok')
		await speaker.connect()
		const sentBefore = sockets[0].sent.length

		const handle = await speaker.preSendTextForSynthesis('  ', () => {})
		handle.pushTextDelta('ignored')
		handle.triggerSynthesisStart()
		await handle.audioComplete

		const newTranscripts = sockets[0].sent.slice(sentBefore).filter((s) => {
			try {
				return JSON.parse(s).transcript
			} catch {
				return false
			}
		})
		assert.equal(newTranscripts.length, 0, 'should not send any text for empty input')
	})

	it('pushTextDelta is a no-op after triggerSynthesisStart', async () => {
		const { speaker, sockets } = createTestSpeaker('ok')
		await speaker.connect()
		const sentBefore = sockets[0].sent.length

		const handle = await speaker.preSendTextForSynthesis('content', () => {})
		handle.triggerSynthesisStart()
		handle.pushTextDelta('too late')
		await handle.audioComplete

		const continuations = sockets[0].sent.slice(sentBefore).filter((s) => {
			const p = JSON.parse(s)
			return p.transcript && p.continue === true
		})
		assert.equal(continuations.length, 1, 'should not send additional text after terminal close')
	})

	it('releases synthesis lock when acquireSocket fails in pre-send', async () => {
		const session = {
			sessionId: 'test-session',
			connect: async () => {},
			acquireSocket: async () => {
				throw new Error('socket unavailable')
			},
			markSynthesisStart: () => {},
			markSynthesisEnd: () => {},
			interrupt: () => {},
			shutdown: () => {},
			isIdle: () => true,
		}
		const speaker = createTtsSpeaker({ session: session as never })

		await assert.rejects(() => speaker.preSendTextForSynthesis('hello', () => {}), /socket unavailable/)
		await assert.rejects(() => speaker.preSendTextForSynthesis('hello again', () => {}), /socket unavailable/)
	})
})

describe('createTtsSpeaker lifecycle', () => {
	it('connect() is idempotent (cached promise, single underlying session.connect)', async () => {
		let sessionConnectCalls = 0
		const { session } = createMockTtsSessionHarness(() => new MockCartesiaTtsSocket('ok') as unknown as WebSocket)
		const originalConnect = session.connect.bind(session)
		session.connect = async () => {
			sessionConnectCalls++
			return originalConnect()
		}
		const speaker = createTtsSpeaker({ session })
		const p1 = speaker.connect()
		const p2 = speaker.connect()
		assert.equal(p1, p2, 'connect returns the cached promise')
		await Promise.all([p1, p2])
		await speaker.connect()
		assert.equal(sessionConnectCalls, 1)
	})

	it('close() is idempotent', async () => {
		let shutdownCalls = 0
		const { session } = createMockTtsSessionHarness(() => new MockCartesiaTtsSocket('ok') as unknown as WebSocket)
		const originalShutdown = session.shutdown.bind(session)
		session.shutdown = () => {
			shutdownCalls++
			originalShutdown()
		}
		const speaker = createTtsSpeaker({ session })
		await speaker.connect()
		speaker.close()
		speaker.close()
		speaker.close()
		assert.equal(shutdownCalls, 1)
	})
})
