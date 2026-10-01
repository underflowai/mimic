import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { flushImmediate } from '#test/support/async.js'
import { AutoOpenMockSocket } from '#test/support/mock-websocket.js'
import { createMockTtsSessionHarness } from '#test/support/tts-session-fixture.js'
import { ttsSampleRate } from '../shared/audio-format.js'
import type { WordTiming } from '../shared/audio-pacing.js'
import { createTtsSpeaker, type TtsSynthesisListener } from './tts-speaker.js'

/** Deliberately not a whole number of frames: the speaker passes provider chunks through untouched. */
const mockChunkBytes = 1234

const ignoreAudio: TtsSynthesisListener = { onAudioChunk: () => {} }

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
			const frame = Buffer.alloc(mockChunkBytes, 9)
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
				this.emitJsonMessage({
					type: 'timestamps',
					context_id: contextId,
					word_timestamps: { words: ['Hello', 'there.'], start: [0, 0.25], end: [0.2, 0.6] },
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
				const frame = Buffer.alloc(mockChunkBytes, 3)
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
		const words: WordTiming[] = []
		const handle = await speaker.preSendTextForSynthesis('Hello there.', {
			onAudioChunk: (c) => chunks.push(c),
			onWordTimings: (w) => words.push(...w),
		})

		const newSent = sockets[0].sent.slice(sentBefore)
		const initial = newSent
			.map((s) => JSON.parse(s))
			.find((p) => p.transcript === 'Hello there.' && p.continue === true)
		assert.ok(initial, 'should send text with continue:true immediately')
		assert.equal(initial.add_timestamps, true, 'should request word timestamps')
		assert.equal(initial.output_format.sample_rate, ttsSampleRate)

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
		assert.equal(chunks[0].length, mockChunkBytes, 'provider chunks are passed through unframed')
		assert.deepEqual(words, [
			{ word: 'Hello', startMs: 0, endMs: 200 },
			{ word: 'there.', startMs: 250, endMs: 600 },
		])
	})

	it('pushTextDelta sends additional continuation messages before trigger', async () => {
		const { speaker, sockets } = createTestSpeaker('ok')
		await speaker.connect()
		const sentBefore = sockets[0].sent.length

		const handle = await speaker.preSendTextForSynthesis('First part. ', ignoreAudio)
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

		const handle = await speaker.preSendTextForSynthesis('fail', ignoreAudio)
		handle.triggerSynthesisStart()
		await assert.rejects(handle.audioComplete, /synthetic failure/)
	})

	it('resolves audioComplete on interrupt', async () => {
		const { speaker } = createTestSpeaker('delayed')
		await speaker.connect()

		const handle = await speaker.preSendTextForSynthesis('wait', ignoreAudio)
		handle.triggerSynthesisStart()
		await flushImmediate()
		speaker.interrupt()
		await handle.audioComplete
	})

	it('second pre-send supersedes the first via epoch bump', async () => {
		const { speaker } = createTestSpeaker('ok')
		await speaker.connect()

		const firstHandle = await speaker.preSendTextForSynthesis('occupying socket', ignoreAudio)
		const secondHandle = await speaker.preSendTextForSynthesis('supersedes first', ignoreAudio)
		secondHandle.triggerSynthesisStart()
		await secondHandle.audioComplete
		await firstHandle.audioComplete
	})

	it('synthesis works after previous pre-send completes', async () => {
		const { speaker } = createTestSpeaker('ok')
		await speaker.connect()

		const handle = await speaker.preSendTextForSynthesis('first', ignoreAudio)
		handle.triggerSynthesisStart()
		await handle.audioComplete

		const chunks: Buffer[] = []
		const handle2 = await speaker.preSendTextForSynthesis('second works', { onAudioChunk: (c) => chunks.push(c) })
		handle2.triggerSynthesisStart()
		await handle2.audioComplete
		assert.ok(chunks.length >= 1, 'should be able to synthesize after pre-send completes')
	})

	it('returns no-op handle for empty text', async () => {
		const { speaker, sockets } = createTestSpeaker('ok')
		await speaker.connect()
		const sentBefore = sockets[0].sent.length

		const handle = await speaker.preSendTextForSynthesis('  ', ignoreAudio)
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

		const handle = await speaker.preSendTextForSynthesis('content', ignoreAudio)
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

		await assert.rejects(() => speaker.preSendTextForSynthesis('hello', ignoreAudio), /socket unavailable/)
		await assert.rejects(() => speaker.preSendTextForSynthesis('hello again', ignoreAudio), /socket unavailable/)
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
