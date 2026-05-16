import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { createActor, fromCallback, fromPromise, waitFor } from 'xstate'

import { createFakeAudioTransport } from '#test/support/fake-audio-transport.js'

import type { InterruptContext } from '../intelligence/types.js'
import type { CommitActorDeps } from './actors/commit-actor.js'
import { playbackWaitActor } from './actors/playback-wait-actor.js'
import type {
	RunTurnActorDeps,
	RunTurnActorEvent,
	RunTurnActorInput,
	RunTurnStrategyInput,
	StreamResult,
} from './actors/run-turn-actor.js'
import { turnActorMachine, type TurnActorInput } from './turn-actor.js'
import type { CommittedTurn, TurnOutcome } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

const waitOpts = { timeout: 2000 }

function defaultStrategy(): RunTurnStrategyInput {
	return { kind: 'fresh', transcript: 'hello', controlBlock: 'test block' }
}

function defaultRunTurnDeps(): RunTurnActorDeps {
	const transport = createFakeAudioTransport()
	return {
		director: {
			streamDraftTokenized: mock.fn(() => ({
				userTranscript: 'hello',
				events: (async function* () {
					yield { type: 'token' as const, value: 'draft' }
					return 'draft'
				})(),
			})),
		},
		tts: {
			connect: async () => {},
			close: () => {},
			interrupt: () => {},
			preSendTextForSynthesis: async () => ({
				pushTextDelta: () => {},
				triggerSynthesisStart: () => {},
				audioComplete: Promise.resolve(),
			}),
		} as unknown as RunTurnActorDeps['tts'],
		getTransport: () => transport,
		sanitize: (text: string) => text,
		registerActiveTurn: () => {},
		clearActiveTurn: () => {},
	}
}

function defaultCommitDeps(): CommitActorDeps {
	return {
		director: { commitTurn: mock.fn(() => {}) },
		incrementTurn: mock.fn(() => {}),
		metrics: { recordTurnTiming: mock.fn(() => {}) },
	}
}

function createTurnActorInput(overrides?: Partial<TurnActorInput>): TurnActorInput {
	return {
		strategy: defaultStrategy(),
		turnId: 1,
		userTranscript: 'hello',
		generationStartedAt: Date.now() - 200,
		lastTurnCompleteAt: Date.now() - 500,
		callerVadEndAt: Date.now() - 400,
		runTurnDeps: defaultRunTurnDeps(),
		commitDeps: defaultCommitDeps(),
		getAudioSenderSnapshot: () => ({ sentMs: 100, confirmedWordsPlayed: 2 }),
		...overrides,
	}
}

function defaultStreamResult(): StreamResult {
	return {
		agentResponse: 'Sure, I can help with that.',
		draftMs: 150,
		firstAudioAt: Date.now() - 50,
		ttsFirstByteMs: 30,
		ttftMs: 80,
		ttcMs: 120,
		audioSent: true,
		endCallRequested: false,
	}
}

function defaultCommittedTurn(): CommittedTurn {
	return {
		turnId: 1,
		userTranscript: 'hello',
		agentResponse: 'Sure, I can help with that.',
		endCallRequested: false,
	}
}

// ---------------------------------------------------------------------------
// Controllable pipeline — a fromCallback the test can drive by sending events
// ---------------------------------------------------------------------------

type PipelineSendBack = (event: RunTurnActorEvent) => void

function createControllablePipeline() {
	let sendBack: PipelineSendBack | null = null
	const ready = createDeferred<PipelineSendBack>()

	const logic = fromCallback<RunTurnActorEvent, RunTurnActorInput>(({ sendBack: sb }) => {
		sendBack = sb
		ready.resolve(sb)
	})

	return {
		logic,
		ready: ready.promise,
		get sendBack() {
			return sendBack!
		},
	}
}

// ---------------------------------------------------------------------------
// Machine factory — provides mock child actors and fast delays
// ---------------------------------------------------------------------------

interface TestMachineConfig {
	commitResult?: CommittedTurn | null
	commitError?: boolean
}

function createTestMachine(pipeline: ReturnType<typeof createControllablePipeline>, config?: TestMachineConfig) {
	const actionCalls: string[] = []

	const commitDeferred = createDeferred<{ committedTurn: CommittedTurn } | null>()

	const provided = turnActorMachine.provide({
		actors: {
			runTurnPipeline: pipeline.logic,
			playbackWait: playbackWaitActor,
			commitActor: fromPromise(async () => {
				if (config?.commitError) throw new Error('commit failed')
				return commitDeferred.promise
			}),
		},
		actions: {
			onPlaybackComplete: () => {
				actionCalls.push('onPlaybackComplete')
			},
			onSuspendAudio: () => {
				actionCalls.push('onSuspendAudio')
			},
			clearBuffer: () => {
				actionCalls.push('clearBuffer')
			},
			drainAudioFade: () => {
				actionCalls.push('drainAudioFade')
			},
			interruptTts: () => {
				actionCalls.push('interruptTts')
			},
			cancelEager: () => {
				actionCalls.push('cancelEager')
			},
			recordBarge: () => {
				actionCalls.push('recordBarge')
			},
			estimateHeardAndCommitPartial: () => {
				actionCalls.push('estimateHeardAndCommitPartial')
			},
			commitDraft: () => {
				actionCalls.push('commitDraft')
			},
			commitUserOnly: () => {
				actionCalls.push('commitUserOnly')
			},
			recordSoftPauseMetrics: () => {
				actionCalls.push('recordSoftPauseMetrics')
			},
			onSubstantiveSpeechTimeout: () => {
				actionCalls.push('onSubstantiveSpeechTimeout')
			},
			recordShortResumedBarge: () => {
				actionCalls.push('recordShortResumedBarge')
			},
			resetPauseState: () => {
				actionCalls.push('resetPauseState')
			},
			flushPausedBuffer: () => {
				actionCalls.push('flushPausedBuffer')
			},
		},
		delays: {
			substantiveSpeechMs: 20,
			yieldWindowMs: 10,
		},
	})

	return { provided, actionCalls, commitDeferred }
}

function startActor(
	pipeline: ReturnType<typeof createControllablePipeline>,
	input?: Partial<TurnActorInput>,
	config?: TestMachineConfig,
) {
	const { provided, actionCalls, commitDeferred } = createTestMachine(pipeline, config)
	const actor = createActor(provided, { input: createTurnActorInput(input) })
	actor.start()
	return { actor, actionCalls, commitDeferred }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Snap = { value: any; context: any }

function matchesState(snap: Snap, path: string): boolean {
	const parts = path.split('.')
	let current = snap.value
	for (const part of parts) {
		if (typeof current === 'string') return current === part
		if (typeof current === 'object' && current !== null && part in current) {
			current = current[part]
		} else {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TurnActor machine', () => {
	describe('happy path: drafting → playing → awaitingPlayback → committing → done(committed)', () => {
		it('completes a full turn lifecycle', async () => {
			const pipeline = createControllablePipeline()
			const { actor, actionCalls, commitDeferred } = startActor(pipeline)

			await pipeline.ready
			assert.ok(matchesState(actor.getSnapshot(), 'executing.generating'))

			pipeline.sendBack({ type: 'audio_started', agentResponse: 'Sure, I can help with that.' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)

			pipeline.sendBack({ type: 'stream_done', result: defaultStreamResult() })
			await waitFor(actor, (s) => matchesState(s, 'awaitingPlayback'), waitOpts)
			assert.ok(actionCalls.includes('onPlaybackComplete'))

			actor.send({ type: 'playback_confirmed' })
			await waitFor(actor, (s) => matchesState(s, 'committing'), waitOpts)

			commitDeferred.resolve({ committedTurn: defaultCommittedTurn() })
			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome
			assert.equal(output.kind, 'committed')
			assert.equal(output.turnId, 1)
			if (output.kind === 'committed') {
				assert.equal(output.turn.agentResponse, 'Sure, I can help with that.')
				assert.equal(output.interruptContext, null)
			}
		})
	})

	describe('interrupt from drafting → done(interrupted)', () => {
		it('produces an interrupted outcome', async () => {
			const pipeline = createControllablePipeline()
			const { actor, actionCalls } = startActor(pipeline)

			await pipeline.ready
			assert.ok(matchesState(actor.getSnapshot(), 'executing.generating'))

			actor.send({ type: 'interrupt', reason: 'caller_started_speaking' })
			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome

			assert.equal(output.kind, 'interrupted')
			if (output.kind === 'interrupted') {
				assert.equal(output.reason, 'caller_started_speaking')
				assert.equal(output.turnId, 1)
			}
			assert.ok(actionCalls.includes('commitUserOnly'))
			assert.ok(actionCalls.includes('cancelEager'))
		})
	})

	describe('interrupt from playing → done(interrupted)', () => {
		it('fires cleanup actions and produces interrupted outcome', async () => {
			const pipeline = createControllablePipeline()
			const { actor, actionCalls } = startActor(pipeline)

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'Sure, I can help with that.' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)

			actor.send({ type: 'interrupt', reason: 'caller_started_speaking' })
			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome

			assert.equal(output.kind, 'interrupted')
			if (output.kind === 'interrupted') {
				assert.equal(output.reason, 'caller_started_speaking')
			}
			assert.ok(actionCalls.includes('clearBuffer'))
			assert.ok(actionCalls.includes('drainAudioFade'))
			assert.ok(actionCalls.includes('interruptTts'))
			assert.ok(actionCalls.includes('recordBarge'))
			assert.ok(actionCalls.includes('estimateHeardAndCommitPartial'))
			assert.ok(!actionCalls.includes('commitUserOnly'))
			assert.ok(actionCalls.includes('cancelEager'))
		})

		it('commits user_only when no agent audio was heard', async () => {
			const pipeline = createControllablePipeline()
			const { actor, actionCalls } = startActor(pipeline, {
				getAudioSenderSnapshot: () => ({ sentMs: 0, confirmedWordsPlayed: 0 }),
			})

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'Sure, I can help with that.' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)

			actor.send({ type: 'interrupt', reason: 'caller_started_speaking' })
			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome

			assert.equal(output.kind, 'interrupted')
			if (output.kind === 'interrupted') {
				assert.equal(output.reason, 'caller_started_speaking')
				assert.equal(output.interruptContext.heardPortion, '')
			}
			assert.ok(actionCalls.includes('recordBarge'))
			assert.ok(actionCalls.includes('commitUserOnly'))
			assert.ok(!actionCalls.includes('estimateHeardAndCommitPartial'))
		})
	})

	describe('soft pause flow: playing → caller_turn_start → softPaused → vad_speech_end → resumed', () => {
		it('pauses and resumes back to playing.flowing', async () => {
			const pipeline = createControllablePipeline()
			const { actor, actionCalls } = startActor(pipeline)

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'draft text' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)

			actor.send({ type: 'caller_turn_start' })
			await waitFor(actor, (s) => matchesState(s, 'executing.softPaused'), waitOpts)
			assert.ok(actionCalls.includes('onSuspendAudio'))

			actor.send({ type: 'vad_speech_end' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)
			assert.ok(actionCalls.includes('flushPausedBuffer'))
			assert.ok(actionCalls.includes('recordSoftPauseMetrics'))
			assert.ok(actionCalls.includes('recordShortResumedBarge'))
		})
	})

	describe('substantive speech timeout from softPaused → interrupted', () => {
		it('fires timeout actions after substantiveSpeechMs delay', async () => {
			const pipeline = createControllablePipeline()
			const { actor, actionCalls } = startActor(pipeline)

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'draft text' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)

			actor.send({ type: 'caller_turn_start' })
			await waitFor(actor, (s) => matchesState(s, 'executing.softPaused'), waitOpts)

			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome

			assert.equal(output.kind, 'interrupted')
			if (output.kind === 'interrupted') {
				assert.equal(output.reason, 'caller_substantive_speech')
			}
			assert.ok(actionCalls.includes('onSubstantiveSpeechTimeout'))
			assert.ok(actionCalls.includes('recordSoftPauseMetrics'))
		})
	})

	describe('empty response → done(discarded)', () => {
		it('produces a discarded outcome with reason empty_response', async () => {
			const pipeline = createControllablePipeline()
			const { actor } = startActor(pipeline)

			await pipeline.ready
			pipeline.sendBack({ type: 'stream_empty', userTranscript: 'hello' })
			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome

			assert.equal(output.kind, 'discarded')
			if (output.kind === 'discarded') {
				assert.equal(output.reason, 'empty_response')
			}
		})
	})

	describe('computedInterruptContext in interrupted output', () => {
		it('uses real sentMs/heardPortion from getAudioSenderSnapshot', async () => {
			const pipeline = createControllablePipeline()
			const { actor } = startActor(pipeline, {
				getAudioSenderSnapshot: () => ({ sentMs: 100, confirmedWordsPlayed: 2 }),
			})

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'word1 word2 word3 word4 word5' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)

			actor.send({ type: 'interrupt', reason: 'caller_started_speaking' })
			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome

			assert.equal(output.kind, 'interrupted')
			if (output.kind === 'interrupted') {
				const ctx: InterruptContext = output.interruptContext
				assert.equal(ctx.sentMs, 100)
				assert.equal(ctx.fullDraft, 'word1 word2 word3 word4 word5')
				assert.ok(ctx.heardPortion.length > 0, 'heardPortion should be non-empty')
				assert.ok(ctx.heardPortion.startsWith('word1'))
			}
		})

		it('falls back to zero sentMs when no barge cleanup ran', async () => {
			const pipeline = createControllablePipeline()
			const { actor } = startActor(pipeline)

			await pipeline.ready
			actor.send({ type: 'interrupt', reason: 'caller_started_speaking' })
			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome

			assert.equal(output.kind, 'interrupted')
			if (output.kind === 'interrupted') {
				assert.equal(output.interruptContext.sentMs, 0)
				assert.equal(output.interruptContext.heardPortion, '')
			}
		})
	})

	describe('stream_error → done(discarded)', () => {
		it('produces a discarded outcome with reason failed', async () => {
			const pipeline = createControllablePipeline()
			const { actor } = startActor(pipeline)

			await pipeline.ready
			pipeline.sendBack({ type: 'stream_error', error: new Error('tts failure') })
			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome

			assert.equal(output.kind, 'discarded')
			if (output.kind === 'discarded') {
				assert.equal(output.reason, 'failed')
			}
		})
	})

	describe('call_ended interrupt from drafting commits user transcript', () => {
		it('fires commitUserOnly for call_ended with a transcript', async () => {
			const pipeline = createControllablePipeline()
			const { actor, actionCalls } = startActor(pipeline)

			await pipeline.ready
			actor.send({ type: 'interrupt', reason: 'call_ended' })
			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome

			assert.equal(output.kind, 'interrupted')
			if (output.kind === 'interrupted') {
				assert.equal(output.reason, 'call_ended')
			}
			assert.ok(actionCalls.includes('commitUserOnly'))
		})
	})

	describe('yield timer from playing.flowing triggers soft pause', () => {
		it('transitions flowing → yielding → softPaused on vad_speech_start', async () => {
			const pipeline = createControllablePipeline()
			const { actor, actionCalls } = startActor(pipeline)

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'draft' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)

			actor.send({ type: 'vad_speech_start' })
			// yieldWindowMs is 10ms, should transition to softPaused
			await waitFor(actor, (s) => matchesState(s, 'executing.softPaused'), waitOpts)
			assert.ok(actionCalls.includes('onSuspendAudio'))
		})
	})

	describe('yield timer cancellation via vad_speech_end in yielding', () => {
		it('returns to flowing if speech ends within yield window', async () => {
			const pipeline = createControllablePipeline()
			const { actor } = startActor(pipeline)

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'draft' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)

			actor.send({ type: 'vad_speech_start' })
			actor.send({ type: 'vad_speech_end' })
			// Should be back in flowing, not transition to softPaused
			const snap = actor.getSnapshot()
			assert.ok(matchesState(snap, 'executing.streaming'))
		})
	})

	describe('commit error → done(discarded with commit_error)', () => {
		it('produces discarded outcome when commit throws', async () => {
			const pipeline = createControllablePipeline()
			const { actor } = startActor(pipeline, {}, { commitError: true })

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'Sure thing' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)
			pipeline.sendBack({ type: 'stream_done', result: defaultStreamResult() })
			await waitFor(actor, (s) => matchesState(s, 'awaitingPlayback'), waitOpts)

			actor.send({ type: 'playback_confirmed' })
			await waitFor(actor, (s) => matchesState(s, 'committing'), waitOpts)

			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome

			assert.equal(output.kind, 'discarded')
			if (output.kind === 'discarded') {
				assert.equal(output.reason, 'commit_error')
			}
		})
	})

	describe('stream_done during softPaused stays paused until vad resolves', () => {
		it('stays in softPaused on stream_done, moves to awaitingPlayback on vad_speech_end', async () => {
			const pipeline = createControllablePipeline()
			const { actor, actionCalls } = startActor(pipeline)

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'draft' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)

			actor.send({ type: 'caller_turn_start' })
			await waitFor(actor, (s) => matchesState(s, 'executing.softPaused'), waitOpts)

			pipeline.sendBack({ type: 'stream_done', result: defaultStreamResult() })
			// Should remain in softPaused — not flush yet
			assert.ok(matchesState(actor.getSnapshot(), 'executing.softPaused'))
			assert.ok(!actionCalls.includes('flushPausedBuffer'))

			// Caller stops speaking → flush and move to awaitingPlayback
			actor.send({ type: 'vad_speech_end' })
			await waitFor(actor, (s) => matchesState(s, 'awaitingPlayback'), waitOpts)
			assert.ok(actionCalls.includes('flushPausedBuffer'))
		})
	})

	describe('interrupt from awaitingPlayback', () => {
		it('non-call_ended interrupt fires barge cleanup', async () => {
			const pipeline = createControllablePipeline()
			const { actor, actionCalls } = startActor(pipeline)

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'Sure, I can help with that.' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)
			pipeline.sendBack({ type: 'stream_done', result: defaultStreamResult() })
			await waitFor(actor, (s) => matchesState(s, 'awaitingPlayback'), waitOpts)

			actor.send({ type: 'interrupt', reason: 'new_turn_started' })
			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome

			assert.equal(output.kind, 'interrupted')
			if (output.kind === 'interrupted') {
				assert.equal(output.reason, 'new_turn_started')
			}
			assert.ok(actionCalls.includes('recordBarge'))
			assert.ok(actionCalls.includes('interruptTts'))
		})

		it('call_ended interrupt commits draft instead of barging', async () => {
			const pipeline = createControllablePipeline()
			const { actor, actionCalls } = startActor(pipeline)

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'response text' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)
			pipeline.sendBack({ type: 'stream_done', result: defaultStreamResult() })
			await waitFor(actor, (s) => matchesState(s, 'awaitingPlayback'), waitOpts)

			actor.send({ type: 'interrupt', reason: 'call_ended' })
			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome

			assert.equal(output.kind, 'interrupted')
			if (output.kind === 'interrupted') {
				assert.equal(output.reason, 'call_ended')
			}
			assert.ok(actionCalls.includes('commitDraft'))
			assert.ok(!actionCalls.includes('recordBarge'))
		})
	})

	describe('awaitingPlayback VAD yield timer interrupt', () => {
		it('interrupts if vad_speech_start persists past yieldWindowMs', async () => {
			const pipeline = createControllablePipeline()
			const { actor } = startActor(pipeline)

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'draft' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)
			pipeline.sendBack({ type: 'stream_done', result: defaultStreamResult() })
			await waitFor(actor, (s) => matchesState(s, 'awaitingPlayback'), waitOpts)

			actor.send({ type: 'vad_speech_start' })
			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome

			assert.equal(output.kind, 'interrupted')
			if (output.kind === 'interrupted') {
				assert.equal(output.reason, 'caller_started_speaking')
			}
		})
	})

	describe('context assignments', () => {
		it('assigns agentResponse and draftResponse on agent_text_finalized', async () => {
			const pipeline = createControllablePipeline()
			const { actor } = startActor(pipeline)

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'my response' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)

			const ctx = actor.getSnapshot().context
			assert.equal(ctx.agentResponse, 'my response')
			assert.equal(ctx.draftResponse, 'my response')
		})

		it('assigns stream timing on stream_done', async () => {
			const pipeline = createControllablePipeline()
			const { actor } = startActor(pipeline)
			const result = defaultStreamResult()

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'response' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)
			pipeline.sendBack({ type: 'stream_done', result })
			await waitFor(actor, (s) => matchesState(s, 'awaitingPlayback'), waitOpts)

			const ctx = actor.getSnapshot().context
			assert.equal(ctx.draftMs, result.draftMs)
			assert.equal(ctx.ttsFirstByteMs, result.ttsFirstByteMs)
			assert.equal(ctx.ttftMs, result.ttftMs)
			assert.equal(ctx.ttcMs, result.ttcMs)
		})

		it('assigns firstAudioAt on first_audio_sent before stream_done', async () => {
			const pipeline = createControllablePipeline()
			const { actor } = startActor(pipeline)
			const firstAudioAt = Date.now()

			await pipeline.ready
			pipeline.sendBack({ type: 'first_audio_sent', at: firstAudioAt })

			await waitFor(actor, (s) => s.context.firstAudioAt === firstAudioAt, waitOpts)
			assert.equal(actor.getSnapshot().context.firstAudioAt, firstAudioAt)
		})

		it('initializes timingKind from strategy', async () => {
			const pipeline = createControllablePipeline()
			const { actor } = startActor(pipeline, {
				strategy: { kind: 'first_turn', openingBlock: 'hello' },
			})

			const ctx = actor.getSnapshot().context
			assert.equal(ctx.timingKind, 'first_turn')
		})
	})

	describe('caller_turn_resumed in softPaused rearms substantive speech timer', () => {
		it('does not fire substantive timeout if caller_turn_resumed arrives before timer', async () => {
			const pipeline = createControllablePipeline()
			const { actor, actionCalls } = startActor(pipeline)

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'draft' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)

			actor.send({ type: 'caller_turn_start' })
			await waitFor(actor, (s) => matchesState(s, 'executing.softPaused'), waitOpts)

			// Send caller_turn_resumed before the 20ms substantiveSpeechMs fires.
			// This should reenter softPaused, rearming the timer.
			actor.send({ type: 'caller_turn_resumed' })

			// Still in softPaused after reenter
			assert.ok(matchesState(actor.getSnapshot(), 'executing.softPaused'))
			assert.ok(!actionCalls.includes('onSubstantiveSpeechTimeout'))

			// Now let the rearmed timer expire → should interrupt
			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			const output = final.output as TurnOutcome
			assert.equal(output.kind, 'interrupted')
			if (output.kind === 'interrupted') {
				assert.equal(output.reason, 'caller_substantive_speech')
			}
			assert.ok(actionCalls.includes('onSubstantiveSpeechTimeout'))
		})
	})

	describe('caller_turn_start in awaitingPlayback forwards to playbackWait', () => {
		it('transitions to committing via playback_settled', async () => {
			const pipeline = createControllablePipeline()
			const { actor, commitDeferred } = startActor(pipeline)

			await pipeline.ready
			pipeline.sendBack({ type: 'audio_started', agentResponse: 'draft' })
			await waitFor(actor, (s) => matchesState(s, 'executing.streaming'), waitOpts)
			pipeline.sendBack({ type: 'stream_done', result: defaultStreamResult() })
			await waitFor(actor, (s) => matchesState(s, 'awaitingPlayback'), waitOpts)

			actor.send({ type: 'caller_turn_start' })
			await waitFor(actor, (s) => matchesState(s, 'committing'), waitOpts)

			commitDeferred.resolve({ committedTurn: defaultCommittedTurn() })
			const final = await waitFor(actor, (s) => s.status === 'done', waitOpts)
			assert.equal((final.output as TurnOutcome).kind, 'committed')
		})
	})
})
