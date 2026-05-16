import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, it } from 'node:test'

import { sanitizeForTts } from '../tts-sanitizer.js'
import type { TtsSpeaker } from '../tts-speaker.js'
import type { SentenceChunkEvent } from './sentence-chunker.js'
import { createTtsSynthesisTransform, type TtsSynthesisHandle } from './tts-synthesis.js'

interface FakeSession {
	firstDelta: string
	extraDeltas: string[]
	openedAt: number
	triggeredAt: number | null
	audioCompletedAt: number | null
	resolveAudioComplete: () => void
	audioComplete: Promise<void>
}

interface FakeSpeakerControls {
	speaker: TtsSpeaker
	sessions: FakeSession[]
	awaitSession: (n: number) => Promise<FakeSession>
	interrupts: number
}

function createFakeSpeaker(): FakeSpeakerControls {
	const sessions: FakeSession[] = []
	const waiters: Array<{ n: number; resolve: (session: FakeSession) => void }> = []
	const state = { interrupts: 0 }

	function notifyWaiters() {
		for (let i = waiters.length - 1; i >= 0; i--) {
			const waiter = waiters[i]
			if (sessions.length >= waiter.n) {
				waiters.splice(i, 1)
				waiter.resolve(sessions[waiter.n - 1])
			}
		}
	}

	const speaker: Partial<TtsSpeaker> = {
		async preSendTextForSynthesis(text, onAudioChunk) {
			const session: FakeSession = {
				firstDelta: text,
				extraDeltas: [],
				openedAt: Date.now(),
				triggeredAt: null,
				audioCompletedAt: null,
				resolveAudioComplete: () => {},
				audioComplete: Promise.resolve(),
			}
			session.audioComplete = new Promise<void>((resolve) => {
				session.resolveAudioComplete = () => {
					if (session.audioCompletedAt !== null) return
					session.audioCompletedAt = Date.now()
					onAudioChunk(Buffer.alloc(4, 1))
					resolve()
				}
			})
			sessions.push(session)
			notifyWaiters()
			return {
				pushTextDelta(delta: string) {
					session.extraDeltas.push(delta)
				},
				triggerSynthesisStart() {
					session.triggeredAt = Date.now()
				},
				audioComplete: session.audioComplete,
			}
		},
		interrupt() {
			state.interrupts += 1
		},
	}

	const awaitSession = (n: number): Promise<FakeSession> => {
		if (sessions.length >= n) return Promise.resolve(sessions[n - 1])
		return new Promise((resolve) => waiters.push({ n, resolve }))
	}

	return {
		speaker: speaker as TtsSpeaker,
		sessions,
		awaitSession,
		get interrupts() {
			return state.interrupts
		},
	} as FakeSpeakerControls
}

async function runSynthesis(
	tokens: Array<string | SentenceChunkEvent>,
	opts: { signal?: AbortSignal; sanitize?: (text: string) => string } = {},
	sessionAutoComplete: boolean = true,
): Promise<{ controls: FakeSpeakerControls; pcm: Buffer[]; done: Promise<void>; handle: TtsSynthesisHandle }> {
	const controls = createFakeSpeaker()
	const handle = createTtsSynthesisTransform({
		tts: controls.speaker,
		sanitize: opts.sanitize ?? ((t) => (t.trim().length === 0 ? '' : t)),
		signal: opts.signal,
	})

	const source = Readable.from(tokens, { objectMode: true })

	const pcm: Buffer[] = []
	const sink = new Writable({
		objectMode: false,
		write(chunk: Buffer, _enc, cb) {
			pcm.push(chunk)
			cb()
		},
	})

	if (sessionAutoComplete) {
		const poll = async () => {
			let cursor = 0
			while (true) {
				const session = await controls.awaitSession(cursor + 1).catch(() => null)
				if (!session) return
				queueMicrotask(() => session.resolveAudioComplete())
				cursor += 1
				await session.audioComplete
			}
		}
		void poll()
	}

	const done = pipeline(source, handle.transform, sink)

	return { controls, pcm, done, handle }
}

describe('createTtsSynthesisTransform', () => {
	it('opens a single TTS session for all sentence batches in a turn', async () => {
		const { controls, done } = await runSynthesis([
			{ type: 'delta', text: 'Hello there. ' },
			{ type: 'boundary' },
			{ type: 'delta', text: 'How are you?' },
			{ type: 'boundary' },
		])
		await done
		assert.equal(controls.sessions.length, 1)
		assert.equal(controls.sessions[0].firstDelta, 'Hello there. ')
		assert.deepEqual(controls.sessions[0].extraDeltas, ['How are you?'])
		assert.notEqual(controls.sessions[0].triggeredAt, null)
	})

	it('streams boundary-sized batches via pushTextDelta on a single handle', async () => {
		const { controls, done } = await runSynthesis(
			[
				{ type: 'delta', text: 'The quick brown fox. ' },
				{ type: 'boundary' },
				{ type: 'delta', text: 'Jumped over.' },
				{ type: 'boundary' },
			],
			{},
		)
		await done
		assert.equal(controls.sessions.length, 1, 'should only open one session per turn')
		const session = controls.sessions[0]
		assert.ok(session.firstDelta.length > 0, 'first delta should open the handle')
		assert.ok(session.extraDeltas.length >= 1, 'subsequent deltas should use pushTextDelta')
	})

	it('preserves spaces at sanitized delta boundaries', async () => {
		const { controls, done, handle } = await runSynthesis(
			[
				{ type: 'delta', text: 'New York, ' },
				{ type: 'boundary' },
				{ type: 'delta', text: "that's a great audience." },
				{ type: 'boundary' },
			],
			{ sanitize: sanitizeForTts },
		)

		await done

		const session = controls.sessions[0]
		assert.equal(session.firstDelta, 'New York, ')
		assert.deepEqual(session.extraDeltas, ["that's a great audience."])
		assert.equal(handle.textSent(), "New York, that's a great audience.")
	})

	it('triggers synthesis start only on flush (end of turn)', async () => {
		const controls = createFakeSpeaker()
		const handle = createTtsSynthesisTransform({
			tts: controls.speaker,
			sanitize: (t) => (t.trim().length === 0 ? '' : t),
		})

		const tokens: SentenceChunkEvent[] = [
			{ type: 'delta', text: 'First sentence. ' },
			{ type: 'boundary' },
			{ type: 'delta', text: 'Second sentence.' },
			{ type: 'boundary' },
		]
		const source = Readable.from(tokens, { objectMode: true })
		const sink = new Writable({
			objectMode: false,
			write(_chunk, _enc, cb) {
				cb()
			},
		})

		const session1Promise = controls.awaitSession(1)
		const donePromise = pipeline(source, handle.transform, sink)

		const session1 = await session1Promise
		assert.equal(session1.firstDelta, 'First sentence. ')
		assert.equal(session1.triggeredAt, null, 'should not trigger before flush')

		session1.resolveAudioComplete()
		await donePromise

		assert.equal(controls.sessions.length, 1, 'should only open one session')
		assert.notEqual(session1.triggeredAt, null, 'should trigger on flush')
	})

	it('flushes trailing text by opening a session if none exists', async () => {
		const { controls, done } = await runSynthesis(['Trailing text no boundary'])
		await done
		assert.equal(controls.sessions.length, 1)
		assert.equal(controls.sessions[0].firstDelta, 'Trailing text no boundary')
		assert.notEqual(controls.sessions[0].triggeredAt, null)
	})

	it('skips empty content gracefully', async () => {
		const { controls, done } = await runSynthesis(['   ', 'Real sentence.'])
		await done
		assert.equal(controls.sessions.length, 1)
		assert.equal(controls.sessions[0].firstDelta.trim(), 'Real sentence.')
	})

	it('holds split inline speech tags until the angle bracket closes', async () => {
		const { controls, done, handle } = await runSynthesis(['<gig', 'gle> ok.'], {
			sanitize: sanitizeForTts,
		})

		await done

		assert.equal(controls.sessions.length, 1)
		assert.equal(controls.sessions[0].firstDelta, ' ok.')
		assert.equal(handle.textSent(), ' ok.')
	})

	it('holds split square-bracket speech tags until the bracket closes', async () => {
		const { controls, done, handle } = await runSynthesis(['[say war', 'mly] Hello there.'], {
			sanitize: sanitizeForTts,
		})

		await done

		assert.equal(controls.sessions.length, 1)
		assert.equal(controls.sessions[0].firstDelta, '[say warmly] Hello there.')
		assert.equal(handle.textSent(), '[say warmly] Hello there.')
	})
})
