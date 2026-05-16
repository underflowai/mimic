/**
 * Silence watchdog tests for the single-state 6s idle timer.
 *
 * Timer control: we use Node's fake timers because XState schedules `after`
 * transitions through `setTimeout`.
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'

import { createFakeAudioTransport } from '#test/support/fake-audio-transport.js'
import { ttsFrameBytes } from '../shared/audio-pacing.js'
import { createCallMachineRuntime, type CallMachineRuntimeDeps } from './call-machine-runtime.js'
import type { TurnOutcome } from './types.js'

function makeSilenceTts() {
	return {
		interrupt: mock.fn(),
		connect: mock.fn(async () => {}),
		close: mock.fn(),
		preSendTextForSynthesis: mock.fn(async (_text: string, onChunk: (c: Buffer) => void) => ({
			pushTextDelta: () => {},
			triggerSynthesisStart: () => onChunk(Buffer.alloc(ttsFrameBytes, 1)),
			audioComplete: Promise.resolve(),
		})),
	} as unknown as CallMachineRuntimeDeps['tts']
}

type LooseOverrides = Partial<CallMachineRuntimeDeps> & Record<string, unknown>

function createDeps(overrides?: LooseOverrides): CallMachineRuntimeDeps {
	const transport = createFakeAudioTransport()
	const { audioSender, audioStreamer, onClearBuffer, onSuspendAudio, onPlaybackComplete, ...rest } =
		overrides ?? ({} as LooseOverrides)
	void audioSender
	void audioStreamer
	void onClearBuffer
	void onSuspendAudio
	void onPlaybackComplete
	return {
		callSignal: new AbortController().signal,
		tts: makeSilenceTts(),
		specTts: makeSilenceTts(),
		getAudioTransport: () => transport,
		configureTranscriber: mock.fn(),
		director: {
			generateDraft: mock.fn(async (t: string) => ({ userTranscript: t, agentResponse: 'draft' })),
			streamDraftTokenized: mock.fn((t: string) => ({
				userTranscript: t,
				events: (async function* () {
					yield { type: 'token' as const, value: 'Still with me?' }
					return 'Still with me?'
				})(),
			})),
			commitTurn: mock.fn(),
			listTurns: () => [],
		} as unknown as CallMachineRuntimeDeps['director'],
		backgroundClient: {
			chat: {
				completions: {
					create: mock.fn(async () => ({
						choices: [{ message: { content: '{"needsTool":false,"toolName":null}' } }],
					})),
				},
			},
		} as unknown as CallMachineRuntimeDeps['backgroundClient'],
		metrics: {
			recordBarge: mock.fn(),
			recordSpeculation: mock.fn(),
			recordSoftPause: mock.fn(),
			recordTurnOutcome: mock.fn(),
			recordTurnTiming: mock.fn(),
			incrementDiscarded: mock.fn(),
		} as unknown as CallMachineRuntimeDeps['metrics'],
		backgroundIntelligence: {
			runPostCommitTasks: mock.fn(async () => {}),
			addKeyterms: mock.fn(),
			drain: mock.fn(async () => {}),
		} as unknown as CallMachineRuntimeDeps['backgroundIntelligence'],
		incrementTurn: mock.fn(),
		sanitize: (text: string) => text,
		classifyPromotion: mock.fn(async () => false),
		buildControlBlock: mock.fn(() => 'mock block'),
		webSearcher: { search: mock.fn(async () => null) } as CallMachineRuntimeDeps['webSearcher'],
		getCallerDateTime: () => undefined,
		getDirectorTurns: () => [],
		onSilenceHangup: mock.fn(),
		...(rest as Partial<CallMachineRuntimeDeps>),
	} satisfies CallMachineRuntimeDeps
}

type BuildControlBlockFn = CallMachineRuntimeDeps['buildControlBlock']

function buildControlBlockMock() {
	return mock.fn<BuildControlBlockFn>(() => 'mock block')
}

function waitForOutcome(engine: ReturnType<typeof createCallMachineRuntime>, turnId: number) {
	return new Promise<TurnOutcome>((resolve) => {
		const sub = engine.actor.on('turn_outcome', ({ outcome }) => {
			if (outcome.turnId !== turnId) return
			sub.unsubscribe()
			resolve(outcome)
		})
	})
}

function autoPlayback(holder: { current?: ReturnType<typeof createCallMachineRuntime> }) {
	return () => queueMicrotask(() => holder.current?.handlePlaybackConfirmed())
}

async function advanceAndFlush(ms: number) {
	mock.timers.tick(ms)
	for (let i = 0; i < 20; i++) await Promise.resolve()
}

function silenceCalls(buildControlBlock: ReturnType<typeof buildControlBlockMock>) {
	return buildControlBlock.mock.calls.filter((call) => call.arguments[1]?.silenceFollowUp === true)
}

describe('silence watchdog', () => {
	beforeEach(() => {
		mock.timers.enable({ apis: ['setTimeout'] })
	})

	afterEach(() => {
		mock.timers.reset()
	})

	it('fires a director follow-up after 6s with retry metadata', async () => {
		const holder: { current?: ReturnType<typeof createCallMachineRuntime> } = {}
		const buildControlBlock = buildControlBlockMock()
		const engine = createCallMachineRuntime(createDeps({ buildControlBlock, onPlaybackComplete: autoPlayback(holder) }))
		holder.current = engine

		const openingId = engine.actor.getSnapshot().context.nextTurnId
		const opening = waitForOutcome(engine, openingId)
		engine.sendToCallMachine({ type: 'start_first_turn', openingBlock: 'Hello!' })
		await opening

		const followUpId = engine.actor.getSnapshot().context.nextTurnId
		const followUp = waitForOutcome(engine, followUpId)
		await advanceAndFlush(6_000)
		await followUp

		const calls = silenceCalls(buildControlBlock)
		assert.equal(calls.length, 1)
		assert.equal(calls[0]?.arguments[1]?.silenceFollowUpCount, 1)
		assert.equal(calls[0]?.arguments[1]?.silenceClosing, false)
		assert.equal(engine.actor.getSnapshot().context.silenceFollowUpCount, 1)
		engine.stop()
	})

	it('caller_update partials do not reset the 6s silence timer', async () => {
		const holder: { current?: ReturnType<typeof createCallMachineRuntime> } = {}
		const buildControlBlock = buildControlBlockMock()
		const engine = createCallMachineRuntime(createDeps({ buildControlBlock, onPlaybackComplete: autoPlayback(holder) }))
		holder.current = engine

		const openingId = engine.actor.getSnapshot().context.nextTurnId
		const opening = waitForOutcome(engine, openingId)
		engine.sendToCallMachine({ type: 'start_first_turn', openingBlock: 'Hello!' })
		await opening

		const followUpId = engine.actor.getSnapshot().context.nextTurnId
		const followUp = waitForOutcome(engine, followUpId)
		for (let i = 0; i < 5; i++) {
			await advanceAndFlush(1_000)
			engine.sendToCallMachine({ type: 'caller_update', transcript: '', confidence: 0.1 })
		}
		await advanceAndFlush(1_000)
		await followUp

		assert.equal(silenceCalls(buildControlBlock).length, 1)
		engine.stop()
	})

	it('vad_speech_start does not reset the silence timer', async () => {
		const holder: { current?: ReturnType<typeof createCallMachineRuntime> } = {}
		const buildControlBlock = buildControlBlockMock()
		const engine = createCallMachineRuntime(createDeps({ buildControlBlock, onPlaybackComplete: autoPlayback(holder) }))
		holder.current = engine

		const openingId = engine.actor.getSnapshot().context.nextTurnId
		const opening = waitForOutcome(engine, openingId)
		engine.sendToCallMachine({ type: 'start_first_turn', openingBlock: 'Hello!' })
		await opening

		const followUpId = engine.actor.getSnapshot().context.nextTurnId
		const followUp = waitForOutcome(engine, followUpId)
		await advanceAndFlush(4_000)
		engine.sendToCallMachine({ type: 'vad_speech_start' })
		await advanceAndFlush(2_000)
		await followUp

		assert.equal(silenceCalls(buildControlBlock).length, 1)
		assert.equal(engine.actor.getSnapshot().context.silenceFollowUpCount, 1)
		engine.stop()
	})

	it('caller_turn_start resets silence count and restarts the timer window', async () => {
		const holder: { current?: ReturnType<typeof createCallMachineRuntime> } = {}
		const buildControlBlock = buildControlBlockMock()
		const engine = createCallMachineRuntime(createDeps({ buildControlBlock, onPlaybackComplete: autoPlayback(holder) }))
		holder.current = engine

		const openingId = engine.actor.getSnapshot().context.nextTurnId
		const opening = waitForOutcome(engine, openingId)
		engine.sendToCallMachine({ type: 'start_first_turn', openingBlock: 'Hi!' })
		await opening

		const firstFollowUpId = engine.actor.getSnapshot().context.nextTurnId
		const firstFollowUp = waitForOutcome(engine, firstFollowUpId)
		await advanceAndFlush(6_000)
		await firstFollowUp
		assert.equal(engine.actor.getSnapshot().context.silenceFollowUpCount, 1)

		engine.sendToCallMachine({ type: 'caller_turn_start' })
		assert.equal(engine.actor.getSnapshot().context.silenceFollowUpCount, 0)

		await advanceAndFlush(5_000)
		assert.equal(silenceCalls(buildControlBlock).length, 1, 'no new follow-up before full 6s window')
		await advanceAndFlush(1_000)
		assert.equal(silenceCalls(buildControlBlock).length, 2, 'new silence window fires after reset')
		engine.stop()
	})

	it('meaningful caller_update restarts the silence window', async () => {
		const holder: { current?: ReturnType<typeof createCallMachineRuntime> } = {}
		const buildControlBlock = buildControlBlockMock()
		const engine = createCallMachineRuntime(createDeps({ buildControlBlock, onPlaybackComplete: autoPlayback(holder) }))
		holder.current = engine

		const openingId = engine.actor.getSnapshot().context.nextTurnId
		const opening = waitForOutcome(engine, openingId)
		engine.sendToCallMachine({ type: 'start_first_turn', openingBlock: 'Hi!' })
		await opening

		const firstFollowUpId = engine.actor.getSnapshot().context.nextTurnId
		const firstFollowUp = waitForOutcome(engine, firstFollowUpId)
		await advanceAndFlush(6_000)
		await firstFollowUp
		assert.equal(engine.actor.getSnapshot().context.silenceFollowUpCount, 1)

		await advanceAndFlush(4_000)
		engine.sendToCallMachine({ type: 'caller_update', transcript: 'I was trying', confidence: 0.3 })
		assert.equal(engine.actor.getSnapshot().context.silenceFollowUpCount, 0)

		await advanceAndFlush(5_000)
		assert.equal(silenceCalls(buildControlBlock).length, 1, 'no new follow-up before full 6s window')
		await advanceAndFlush(1_000)
		assert.equal(silenceCalls(buildControlBlock).length, 2, 'new silence window fires after reset')
		engine.stop()
	})

	it('caller_turn_resumed restarts the silence window', async () => {
		const holder: { current?: ReturnType<typeof createCallMachineRuntime> } = {}
		const buildControlBlock = buildControlBlockMock()
		const engine = createCallMachineRuntime(createDeps({ buildControlBlock, onPlaybackComplete: autoPlayback(holder) }))
		holder.current = engine

		const openingId = engine.actor.getSnapshot().context.nextTurnId
		const opening = waitForOutcome(engine, openingId)
		engine.sendToCallMachine({ type: 'start_first_turn', openingBlock: 'Hi!' })
		await opening

		const firstFollowUpId = engine.actor.getSnapshot().context.nextTurnId
		const firstFollowUp = waitForOutcome(engine, firstFollowUpId)
		await advanceAndFlush(6_000)
		await firstFollowUp
		assert.equal(engine.actor.getSnapshot().context.silenceFollowUpCount, 1)

		await advanceAndFlush(4_000)
		engine.sendToCallMachine({ type: 'caller_turn_resumed', transcript: '' })
		assert.equal(engine.actor.getSnapshot().context.silenceFollowUpCount, 0)

		await advanceAndFlush(5_000)
		assert.equal(silenceCalls(buildControlBlock).length, 1, 'no new follow-up before full 6s window')
		await advanceAndFlush(1_000)
		assert.equal(silenceCalls(buildControlBlock).length, 2, 'new silence window fires after reset')
		engine.stop()
	})

	it('accepted caller_turn_complete resets silence count even without caller_turn_start', async () => {
		const holder: { current?: ReturnType<typeof createCallMachineRuntime> } = {}
		const engine = createCallMachineRuntime(createDeps({ onPlaybackComplete: autoPlayback(holder) }))
		holder.current = engine

		const openingId = engine.actor.getSnapshot().context.nextTurnId
		const opening = waitForOutcome(engine, openingId)
		engine.sendToCallMachine({ type: 'start_first_turn', openingBlock: 'Hi!' })
		await opening

		const followUpId = engine.actor.getSnapshot().context.nextTurnId
		const followUp = waitForOutcome(engine, followUpId)
		await advanceAndFlush(6_000)
		await followUp
		assert.equal(engine.actor.getSnapshot().context.silenceFollowUpCount, 1)

		const callerTurnId = engine.actor.getSnapshot().context.nextTurnId
		const callerTurn = waitForOutcome(engine, callerTurnId)
		engine.sendToCallMachine({ type: 'caller_turn_complete', transcript: 'yeah', confidence: 0.95 })
		await callerTurn

		assert.equal(engine.actor.getSnapshot().context.silenceFollowUpCount, 0)
		engine.stop()
	})

	it('escalates retries to closing guidance then hangs up immediately after the closing turn commits', async () => {
		const holder: { current?: ReturnType<typeof createCallMachineRuntime> } = {}
		const onSilenceHangup = mock.fn<() => void>()
		const buildControlBlock = buildControlBlockMock()
		const engine = createCallMachineRuntime(
			createDeps({
				onSilenceHangup,
				buildControlBlock,
				onPlaybackComplete: autoPlayback(holder),
			}),
		)
		holder.current = engine

		const openingId = engine.actor.getSnapshot().context.nextTurnId
		const opening = waitForOutcome(engine, openingId)
		engine.sendToCallMachine({ type: 'start_first_turn', openingBlock: 'Hi!' })
		await opening

		for (const retry of [1, 2, 3]) {
			const followUpId = engine.actor.getSnapshot().context.nextTurnId
			const followUp = waitForOutcome(engine, followUpId)
			await advanceAndFlush(6_000)
			await followUp
			const call = silenceCalls(buildControlBlock)[retry - 1]
			assert.equal(call?.arguments[1]?.silenceFollowUpCount, retry)
			assert.equal(call?.arguments[1]?.silenceClosing, retry === 3)
		}

		assert.equal(engine.actor.getSnapshot().context.silenceFollowUpCount, 3)
		assert.equal(onSilenceHangup.mock.calls.length, 1)
		engine.stop()
	})

	it('does not run silence timer while inTurn is active', async () => {
		const buildControlBlock = buildControlBlockMock()
		const engine = createCallMachineRuntime(
			createDeps({ buildControlBlock, onPlaybackComplete: mock.fn<() => void>() }),
		)

		engine.sendToCallMachine({ type: 'start_first_turn', openingBlock: 'Hello!' })
		for (let i = 0; i < 20; i++) await Promise.resolve()
		assert.equal(engine.actor.getSnapshot().value, 'inTurn')

		await advanceAndFlush(20_000)
		assert.equal(silenceCalls(buildControlBlock).length, 0)
		engine.stop()
	})
})
