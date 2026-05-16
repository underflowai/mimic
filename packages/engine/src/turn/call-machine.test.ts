/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { assign, createActor, createMachine } from 'xstate'

import { createFakeAudioTransport } from '#test/support/fake-audio-transport.js'
import { waitForCondition } from '#test/support/wait-for-condition.js'
import { callMachine, dispatchTurnComplete, matchTurnActorState, type CallMachineInput } from './call-machine.js'
import type { TurnOutcome } from './types.js'

function createNoopCallMachineInput(): CallMachineInput {
	const transport = createFakeAudioTransport()
	const noopTts = {
		interrupt: () => {},
		close: () => {},
		connect: async () => {},
		preSendTextForSynthesis: async () => ({
			pushTextDelta: () => {},
			triggerSynthesisStart: () => {},
			audioComplete: Promise.resolve(),
		}),
	}
	return {
		runTurnDeps: {
			director: {
				streamDraftTokenized: mock.fn((transcript: string) => ({
					userTranscript: transcript,
					events: (async function* () {
						yield { type: 'token' as const, value: 'draft' }
						return 'draft'
					})(),
				})),
			},
			tts: noopTts as any,
			getTransport: () => transport,
			sanitize: (text: string) => text,
			registerActiveTurn: () => {},
			clearActiveTurn: () => {},
		},
		commitDeps: {
			director: {
				commitTurn: () => {},
			},
			incrementTurn: () => {},
			metrics: { recordTurnTiming: () => {} },
		},
		getAudioSenderSnapshot: () => ({ sentMs: 0, confirmedWordsPlayed: 0 }),
	}
}

function createInterruptibleTurnActorMachine(options?: { initialSubstate?: 'generating' | 'softPaused' }) {
	const initialSubstate = options?.initialSubstate ?? 'generating'
	return createMachine({
		id: 'turnActor',
		types: {
			input: {} as {
				turnId: number
				userTranscript: string
			},
			context: {} as {
				turnId: number
				userTranscript: string
				interruptReason: string | null
			},
			events: {} as { type: 'interrupt'; reason: string },
			output: {} as TurnOutcome,
		},
		initial: 'executing',
		context: ({ input }) => ({
			turnId: input.turnId,
			userTranscript: input.userTranscript,
			interruptReason: null,
		}),
		states: {
			executing: {
				initial: initialSubstate,
				states: { generating: {}, softPaused: {} },
				after: { 20: { target: '#turnActor.done' } },
				on: {
					interrupt: {
						target: '#turnActor.done',
						actions: assign({ interruptReason: ({ event }) => event.reason }),
					},
				},
			},
			done: { type: 'final' },
		},
		output: ({ context }) => {
			if (context.interruptReason) {
				return {
					kind: 'interrupted',
					turnId: context.turnId,
					transcript: context.userTranscript,
					interruptContext: { fullDraft: 'draft', sentMs: 10, heardPortion: 'draft' },
					reason: context.interruptReason as TurnOutcome extends { reason: infer R } ? R : never,
				} as TurnOutcome
			}
			return {
				kind: 'committed',
				turnId: context.turnId,
				turn: {
					turnId: context.turnId,
					userTranscript: context.userTranscript,
					agentResponse: 'reply',
					endCallRequested: false,
				},
				interruptContext: null,
			} as TurnOutcome
		},
	})
}

function createDispatchContext(overrides?: Partial<Record<string, unknown>>) {
	return {
		backchannelResumedPending: false,
		lastTurnWasInterrupted: false,
		lastVadSpeechEndAt: 0,
		lastTurnCompleteAt: 0,
		callerVadEndAt: 0,
		nextTurnId: 7,
		isClosing: false,
		toolHasInflight: false,
		pendingStrategy: null,
		pendingTurnComplete: null,
		pendingSilenceClosing: false,
		silenceFollowUpCount: 0,
		runTurnDeps: createNoopCallMachineInput().runTurnDeps,
		commitDeps: createNoopCallMachineInput().commitDeps,
		getAudioSenderSnapshot: null,
		...overrides,
	}
}

function createTurnCompleteEvent(overrides?: Partial<Record<string, unknown>>) {
	return {
		type: 'turn_complete',
		transcript: 'hello world',
		confidence: 0.9,
		controlBlock: 'test block',
		agentLastResponse: 'previous',
		...overrides,
	}
}

describe('dispatchTurnComplete priority handling', () => {
	const priorityCases = [
		{
			name: 'closing emits discarded and commitUserOnly',
			mode: 'inTurn',
			context: { isClosing: true },
			event: createTurnCompleteEvent({ transcript: '  keep me  ' }),
			turnActorSnapshot: null,
			expected: { kind: 'emit', outcomeKind: 'discarded', reason: 'closing', commitUserOnly: 'keep me' },
		},
		{
			name: 'backchannel resumed emits discarded',
			mode: 'idle',
			context: { backchannelResumedPending: true },
			event: createTurnCompleteEvent(),
			turnActorSnapshot: null,
			expected: { kind: 'emit', outcomeKind: 'discarded', reason: 'backchannel_handled' },
		},
		{
			name: 'soft paused active turn emits deferred',
			mode: 'inTurn',
			context: {},
			event: createTurnCompleteEvent(),
			turnActorSnapshot: { value: { executing: { softPaused: {} } } },
			expected: { kind: 'emit', outcomeKind: 'deferred', reason: 'soft_paused' },
		},
	] as const

	for (const testCase of priorityCases) {
		it(testCase.name, () => {
			const result = dispatchTurnComplete({
				mode: testCase.mode,
				context: createDispatchContext(testCase.context),
				event: testCase.event,
				snapshot: { children: {} },
				turnActorSnapshot: testCase.turnActorSnapshot as any,
			} as any)

			assert.equal(result.kind, testCase.expected.kind)
			if (result.kind !== 'emit') return
			assert.equal(result.outcome.kind, testCase.expected.outcomeKind)
			assert.equal((result.outcome as { reason: string }).reason, testCase.expected.reason)
			assert.equal((result as any).commitUserOnly, (testCase.expected as any).commitUserOnly)
		})
	}

	it('idle fresh strategy creates pending start state', () => {
		const result = dispatchTurnComplete({
			mode: 'idle',
			context: createDispatchContext(),
			event: createTurnCompleteEvent(),
			snapshot: { children: {} },
			turnActorSnapshot: null,
		} as any)

		assert.equal(result.kind, 'start')
		if (result.kind !== 'start') return
		assert.equal(result.pending.turnId, 7)
		assert.equal(result.pending.userTranscript, 'hello world')
		assert.equal(result.pending.strategy.kind, 'fresh')
	})

	it('inTurn non-terminal strategy stores pending turn and interrupts active actor', () => {
		const result = dispatchTurnComplete({
			mode: 'inTurn',
			context: createDispatchContext(),
			event: createTurnCompleteEvent({ transcript: 'second turn', confidence: 0.7 }),
			snapshot: { children: {} },
			turnActorSnapshot: { value: { executing: { generating: {} } } },
		} as any)

		assert.equal(result.kind, 'interrupt-active')
		if (result.kind !== 'interrupt-active') return
		assert.equal(result.pending.transcript, 'second turn')
		assert.equal(result.pending.confidence, 0.7)
	})

	it('idle eagerGenerating strategy creates start dispatch with racingPromotion', () => {
		const mockEagerActor = {
			getSnapshot: () => ({
				value: 'eagerGenerating',
				context: {
					turnId: 5,
					eagerDraft: null,
					eagerGeneratedAt: 0,
					sink: null,
					ttsPromise: null,
					triggerSynthesisStart: null,
					eagerStartedAt: 0,
					turnResumedSince: false,
					validatedTranscript: null,
				},
			}),
		}
		const result = dispatchTurnComplete({
			mode: 'idle',
			context: createDispatchContext(),
			event: createTurnCompleteEvent(),
			snapshot: { children: { 'eager-pipeline': mockEagerActor } },
			turnActorSnapshot: null,
		} as any)

		assert.equal(result.kind, 'start')
		if (result.kind !== 'start') return
		assert.equal(result.pending.strategy.kind, 'fresh')
		if (result.pending.strategy.kind === 'fresh') {
			assert.equal(result.pending.strategy.racingPromotion, true)
		}
	})
})

describe('matchTurnActorState path matching', () => {
	const pathCases = [
		{
			name: 'matches nested soft paused state',
			value: { executing: { softPaused: {} } },
			path: 'executing.softPaused',
			expected: true,
		},
		{
			name: 'matches top-level awaiting state',
			value: 'awaitingPlayback',
			path: 'awaitingPlayback',
			expected: true,
		},
		{
			name: 'does not match different branch',
			value: { executing: { generating: {} } },
			path: 'executing.softPaused',
			expected: false,
		},
	] as const

	for (const testCase of pathCases) {
		it(testCase.name, () => {
			const snapshot = { value: testCase.value } as any
			assert.equal(matchTurnActorState(snapshot, testCase.path), testCase.expected)
		})
	}
})

describe('callMachine turn replay behavior', () => {
	it('replays pending turn_complete after interrupting active turn', async () => {
		const outcomes: TurnOutcome[] = []
		const actor = createActor(
			callMachine.provide({
				actors: { turnActor: createInterruptibleTurnActorMachine() as any },
			}),
			{ input: createNoopCallMachineInput() },
		).start()

		actor.on('turn_outcome', ({ outcome }) => outcomes.push(outcome))

		actor.send({
			type: 'turn_complete',
			transcript: 'first question',
			confidence: 0.9,
			controlBlock: '',
			agentLastResponse: '',
		})
		actor.send({
			type: 'turn_complete',
			transcript: 'second question',
			confidence: 0.8,
			controlBlock: '',
			agentLastResponse: '',
		})

		await waitForCondition(() => outcomes.length >= 2, 600)
		assert.equal(outcomes[0]?.kind, 'interrupted')
		assert.equal(outcomes[1]?.kind, 'committed')
		assert.equal(outcomes[0]?.turnId, 0)
		assert.equal(outcomes[1]?.turnId, 1)
		if (outcomes[0]?.kind === 'interrupted') assert.equal(outcomes[0].reason, 'new_turn_started')
		if (outcomes[1]?.kind === 'committed') assert.equal(outcomes[1].turn.userTranscript, 'second question')

		actor.stop()
	})
})
