/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Machine-level tests for CallMachine — exercises the XState actor with
 * mock child machines (not the full runtime, not pure functions).
 */

import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { createActor, createMachine } from 'xstate'

import { createFakeAudioTransport } from '#test/support/fake-audio-transport.js'
import { waitForCondition } from '#test/support/wait-for-condition.js'
import { callMachine, type CallMachineInput } from './call-machine.js'
import type { TurnOutcome } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createNoopInput(): CallMachineInput {
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
			director: { commitTurn: () => {} },
			incrementTurn: () => {},
			metrics: { recordTurnTiming: () => {} },
		},
		getAudioSenderSnapshot: () => ({ sentMs: 0, confirmedWordsPlayed: 0 }),
	}
}

function makeTurnComplete(transcript = 'hello', confidence = 0.9) {
	return {
		type: 'turn_complete' as const,
		transcript,
		confidence,
		controlBlock: 'test control block',
		agentLastResponse: 'previous reply',
	}
}

/**
 * Minimal eager child mock. Starts in idle, responds to EAGER_TURN by
 * moving to `eagerGenerating`, and supports final validation from `ready`.
 */
function createControllableEagerMachine() {
	const machine = createMachine({
		id: 'eager',
		initial: 'idle',
		context: {
			turnId: 0,
			transcript: '',
			controlBlock: '',
			abort: null,
			eagerDraft: null,
			eagerStartedAt: 0,
			eagerGeneratedAt: 0,
			sink: null,
			triggerSynthesisStart: null,
			ttsPromise: null,
			turnResumedSince: false,
			validatedTranscript: null,
		},
		on: {
			CANCEL: { target: '.idle' },
		},
		states: {
			idle: {
				on: {
					EAGER_TURN: 'eagerGenerating',
				},
			},
			eagerGenerating: {},
			ready: {
				on: { FINAL_TURN_VALIDATE: 'validating' },
			},
			validating: {},
		},
	})

	return { machine }
}

function createNoopSearchMachine() {
	return createMachine({
		id: 'search',
		initial: 'active',
		context: { tasks: [] as unknown[], nextTaskId: 0 },
		states: { active: {} },
	})
}

/**
 * Build a callMachine actor with controllable eager child and noop search.
 * Returns the actor plus helpers for asserting outcomes.
 */
function setup(overrides?: {
	turnActor?: any
	eagerMachine?: any
	actionSpies?: Record<string, ReturnType<typeof mock.fn>>
}) {
	const outcomes: TurnOutcome[] = []
	const actionSpies = {
		cancelEager: mock.fn(),
		recordTurnOutcomeMetric: mock.fn(),
		commitUserOnly: mock.fn(),
		triggerEagerTurn: mock.fn(),
		completeCallerTurn: mock.fn(),
		markEagerTurnResumed: mock.fn(),
		onEagerSpeculationMetrics: mock.fn(),
		...overrides?.actionSpies,
	}

	const defaultTurnActor = createMachine({
		id: 'turnActor',
		types: { input: {} as Record<string, unknown>, output: {} as TurnOutcome },
		initial: 'executing',
		context: ({ input }) => ({ turnId: (input as { turnId?: number }).turnId ?? 0 }),
		states: {
			executing: {
				after: { 15: 'done' },
				on: { interrupt: 'done' },
			},
			done: { type: 'final' },
		},
		output: ({ context }): TurnOutcome => ({
			kind: 'committed',
			turnId: (context as { turnId: number }).turnId,
			turn: {
				turnId: (context as { turnId: number }).turnId,
				userTranscript: '',
				agentResponse: 'reply',
				endCallRequested: false,
			},
			interruptContext: null,
		}),
	})

	const provided = callMachine.provide({
		actors: {
			turnActor: (overrides?.turnActor ?? defaultTurnActor) as any,
			eagerPipeline: (overrides?.eagerMachine ?? createNoopSearchMachine()) as any,
		},
		actions: actionSpies as any,
	})

	const actor = createActor(provided, { input: createNoopInput() })
	actor.on('turn_outcome', ({ outcome }) => outcomes.push(outcome))

	return { actor, outcomes, actionSpies }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CallMachine: eager generating races fresh at EOT', () => {
	it('starts fresh turn immediately when eager is still generating at turn_complete', async () => {
		const { machine: eagerMachine } = createControllableEagerMachine()
		const { actor, outcomes } = setup({ eagerMachine })
		actor.start()

		const eagerRef = actor.getSnapshot().children['eager-pipeline'] as any
		assert.ok(eagerRef)
		eagerRef.send({ type: 'EAGER_TURN', transcript: 'hello', controlBlock: '', turnId: 5 })

		await waitForCondition(() => eagerRef.getSnapshot().value === 'eagerGenerating', 200)

		actor.send(makeTurnComplete('hello'))

		await waitForCondition(() => actor.getSnapshot().value === 'inTurn', 200)
		assert.equal(actor.getSnapshot().value, 'inTurn', 'turn starts immediately without gate stall')

		await waitForCondition(() => outcomes.length >= 1, 600)
		assert.equal(outcomes[0]?.kind, 'committed')

		actor.stop()
	})
})

describe('CallMachine: onError emits discarded outcome', () => {
	it('emits discarded outcome when turn actor fails', async () => {
		const failingTurnActor = createMachine({
			id: 'turnActor',
			types: { input: {} as Record<string, unknown>, output: {} as TurnOutcome },
			initial: 'exploding',
			states: {
				exploding: {
					entry: () => {
						throw new Error('boom')
					},
					type: 'final' as const,
				},
			},
			output: (): TurnOutcome => ({
				kind: 'discarded',
				turnId: 0,
				reason: 'failed',
			}),
		})

		const { actor, outcomes } = setup({ turnActor: failingTurnActor })
		actor.start()

		actor.send(makeTurnComplete('what is insurance'))

		await waitForCondition(() => outcomes.length >= 1, 600)

		assert.equal(outcomes[0]?.kind, 'discarded')
		if (outcomes[0]?.kind === 'discarded') {
			assert.equal(outcomes[0].reason, 'failed')
		}

		actor.stop()
	})
})

describe('CallMachine: interruptContext comes from TurnActor output', () => {
	it('emits turn_outcome with interruptContext from turnActor, not parent context', async () => {
		const specificInterruptContext = {
			fullDraft: 'the full agent draft about insurance',
			sentMs: 4200,
			heardPortion: 'the full agent',
		}

		const interruptingTurnActor = createMachine({
			id: 'turnActor',
			types: {
				input: {} as Record<string, unknown>,
				output: {} as TurnOutcome,
			},
			initial: 'executing',
			context: ({ input }) => ({
				turnId: (input as { turnId?: number }).turnId ?? 0,
				userTranscript: (input as { userTranscript?: string }).userTranscript ?? '',
			}),
			states: {
				executing: {
					on: {
						interrupt: 'done',
					},
				},
				done: { type: 'final' },
			},
			output: ({ context }): TurnOutcome => ({
				kind: 'interrupted',
				turnId: (context as { turnId: number }).turnId,
				transcript: (context as { userTranscript: string }).userTranscript,
				interruptContext: specificInterruptContext,
				reason: 'caller_started_speaking',
			}),
		})

		const { actor, outcomes } = setup({ turnActor: interruptingTurnActor })
		actor.start()

		actor.send(makeTurnComplete('tell me about insurance'))

		// Wait for the machine to reach inTurn
		await waitForCondition(() => actor.getSnapshot().value === 'inTurn', 200)

		// Interrupt the turn
		actor.send({ type: 'interrupt', reason: 'caller_started_speaking' })

		await waitForCondition(() => outcomes.length >= 1, 600)

		assert.equal(outcomes[0]?.kind, 'interrupted')
		if (outcomes[0]?.kind === 'interrupted') {
			assert.deepEqual(outcomes[0].interruptContext, specificInterruptContext)
			assert.equal(outcomes[0].interruptContext.fullDraft, 'the full agent draft about insurance')
			assert.equal(outcomes[0].interruptContext.sentMs, 4200)
			assert.equal(outcomes[0].interruptContext.heardPortion, 'the full agent')
		}

		actor.stop()
	})
})

// Regression: before the fix, a substantive-speech escalation landed the call
// machine in the `interrupted` sub-state with no pending turn_complete, and
// the caller's follow-up EndOfTurn (`caller_turn_complete`) had no handler
// there and was silently dropped — the agent went dead until call teardown.
describe('CallMachine: caller_turn_complete while in interrupted state', () => {
	it('routes caller_turn_complete through completeCallerTurn and leaves the interrupted state', async () => {
		const interruptingTurnActor = createMachine({
			id: 'turnActor',
			types: {
				input: {} as Record<string, unknown>,
				output: {} as TurnOutcome,
			},
			initial: 'executing',
			context: ({ input }) => ({
				turnId: (input as { turnId?: number }).turnId ?? 0,
				userTranscript: (input as { userTranscript?: string }).userTranscript ?? '',
			}),
			states: {
				executing: { on: { interrupt: 'done' } },
				done: { type: 'final' },
			},
			output: ({ context }): TurnOutcome => ({
				kind: 'interrupted',
				turnId: (context as { turnId: number }).turnId,
				transcript: (context as { userTranscript: string }).userTranscript,
				interruptContext: { fullDraft: 'draft', sentMs: 100, heardPortion: 'dr' },
				reason: 'caller_substantive_speech',
			}),
		})

		const { actor, outcomes, actionSpies } = setup({ turnActor: interruptingTurnActor })
		actor.start()

		actor.send(makeTurnComplete('initial'))
		await waitForCondition(() => actor.getSnapshot().value === 'inTurn', 200)

		actor.send({ type: 'interrupt', reason: 'caller_substantive_speech' })

		await waitForCondition(() => actor.getSnapshot().value === 'interrupted', 200)
		assert.equal(outcomes.length, 1)
		assert.equal(outcomes[0]?.kind, 'interrupted')
		assert.equal(actor.getSnapshot().value, 'interrupted')

		actor.send({
			type: 'caller_turn_complete',
			transcript: 'actually stop that thought',
			confidence: 0.88,
		})

		await waitForCondition(() => actor.getSnapshot().value !== 'interrupted', 200)
		assert.ok(
			actionSpies.completeCallerTurn.mock.calls.length > 0,
			'completeCallerTurn must run — otherwise the EOT was silently dropped',
		)
		assert.notEqual(actor.getSnapshot().value, 'interrupted', 'should leave the interrupted sub-state')

		actor.stop()
	})
})

describe('CallMachine: validation race promotion swap', () => {
	it('swaps fresh racing strategy to presynthesized when promotion resolves before fresh audio', async () => {
		const eagerReadyMachine = createMachine({
			id: 'eager',
			initial: 'ready',
			context: {
				turnId: 11,
				transcript: 'hello',
				controlBlock: 'test control block',
				abort: null,
				eagerDraft: {
					agentResponse: 'eager answer',
					userTranscript: 'hello',
					controlBlock: 'test control block',
				},
				eagerStartedAt: 123,
				eagerGeneratedAt: 124,
				sink: { chunks: [], done: false, forward: null },
				triggerSynthesisStart: null,
				ttsPromise: Promise.resolve(),
				turnResumedSince: false,
				validatedTranscript: null,
			},
			states: {
				ready: {
					on: { FINAL_TURN_VALIDATE: 'ready' },
				},
				validating: {},
			},
		})

		const longRunningTurnActor = createMachine({
			id: 'turnActor',
			types: { input: {} as Record<string, unknown>, output: {} as TurnOutcome },
			initial: 'executing',
			context: ({ input }) => ({
				turnId: (input as { turnId?: number }).turnId ?? 0,
				firstAudioAt: null as number | null,
			}),
			states: {
				executing: {
					initial: 'generating',
					states: {
						generating: {
							on: {
								first_audio_sent: {
									target: 'streaming',
									actions: ({ context }) => {
										;(context as { firstAudioAt: number | null }).firstAudioAt = Date.now()
									},
								},
							},
						},
						streaming: {},
					},
					on: { interrupt: 'done' },
				},
				done: { type: 'final' },
			},
			output: ({ context }): TurnOutcome => ({
				kind: 'committed',
				turnId: (context as { turnId: number }).turnId,
				turn: {
					turnId: (context as { turnId: number }).turnId,
					userTranscript: '',
					agentResponse: 'reply',
					endCallRequested: false,
				},
				interruptContext: null,
			}),
		})

		const { actor } = setup({ eagerMachine: eagerReadyMachine, turnActor: longRunningTurnActor })
		actor.start()

		actor.send(makeTurnComplete('hello there'))
		await waitForCondition(() => actor.getSnapshot().value === 'inTurn', 200)
		assert.equal(actor.getSnapshot().context.pendingStrategy?.strategy.kind, 'fresh')

		actor.send({ type: 'promotion_resolved', promoted: true })
		await waitForCondition(() => actor.getSnapshot().context.pendingStrategy?.strategy.kind === 'presynthesized', 200)

		assert.equal(actor.getSnapshot().context.pendingStrategy?.strategy.kind, 'presynthesized')
		actor.stop()
	})
})
