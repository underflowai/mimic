/**
 * Eager Pipeline Machine (XState v5)
 *
 * Models eager-end speculation:
 *  - at EagerEndOfTurn, generate one draft from the eager transcript and
 *    pre-send it to secondary TTS;
 *  - before EndOfTurn reuse, validate the current draft against the final
 *    transcript and only then expose it as presynthesized audio.
 */

import { fromPromise, sendParent, setup, type ActorRefFrom, type DoneActorEvent, type ErrorActorEvent } from 'xstate'

import type { EagerAudioSink } from './types.js'

export interface EagerPreparedResult {
	agentResponse: string
	userTranscript: string
	controlBlock: string
	sink: EagerAudioSink
	triggerSynthesisStart: (() => void) | null
	ttsPromise: Promise<void> | null
}

export interface ValidationResult {
	valid: boolean
}

export interface EagerMachineContext {
	turnId: number
	transcript: string
	controlBlock: string
	abort: AbortController | null

	eagerDraft: {
		agentResponse: string
		userTranscript: string
		controlBlock: string
	} | null
	eagerStartedAt: number
	eagerGeneratedAt: number
	validatedTranscript: string | null

	sink: EagerAudioSink | null
	triggerSynthesisStart: (() => void) | null
	ttsPromise: Promise<void> | null

	turnResumedSince: boolean

	pendingValidate: {
		transcript: string
		controlBlock: string
		turnId: number
	} | null
}

export type EagerMachineEvent =
	| {
			type: 'EAGER_TURN'
			transcript: string
			controlBlock: string
			turnId: number
	  }
	| {
			type: 'FINAL_TURN_VALIDATE'
			transcript: string
			controlBlock: string
			turnId: number
	  }
	| { type: 'CANCEL' }
	| { type: 'MARK_TURN_RESUMED' }

type InternalEvent =
	| DoneActorEvent<EagerPreparedResult | null, string>
	| DoneActorEvent<ValidationResult, string>
	| ErrorActorEvent<unknown, string>

export const eagerMachineSetup = setup({
	types: {
		context: {} as EagerMachineContext,
		events: {} as EagerMachineEvent | InternalEvent,
	},
	actors: {
		eagerGeneration: fromPromise<
			EagerPreparedResult | null,
			{ transcript: string; controlBlock: string; signal: AbortSignal }
		>(async () => null),
		finalValidator: fromPromise<
			ValidationResult,
			{ basisTranscript: string; finalTranscript: string; draftResponse: string | null; signal: AbortSignal }
		>(async () => ({ valid: false })),
	},
	actions: {
		abortCurrent: (_, _params: { abort: AbortController }) => {},
		interruptSpecTts: () => {},
	},
})

const resetContext = eagerMachineSetup.assign({
	turnId: 0,
	transcript: '',
	controlBlock: '',
	abort: null,
	eagerDraft: null,
	eagerStartedAt: 0,
	eagerGeneratedAt: 0,
	validatedTranscript: null,
	sink: null,
	triggerSynthesisStart: null,
	ttsPromise: null,
	turnResumedSince: false,
	pendingValidate: null,
})

const assignEagerTurn = eagerMachineSetup.assign({
	turnId: ({ event }) => (event.type === 'EAGER_TURN' ? event.turnId : 0),
	transcript: ({ event }) => (event.type === 'EAGER_TURN' ? event.transcript : ''),
	controlBlock: ({ event }) => (event.type === 'EAGER_TURN' ? event.controlBlock : ''),
	abort: () => new AbortController(),
	eagerStartedAt: () => Date.now(),
	eagerDraft: null,
	eagerGeneratedAt: 0,
	validatedTranscript: null,
	sink: null,
	triggerSynthesisStart: null,
	ttsPromise: null,
	turnResumedSince: false,
	pendingValidate: null,
})

const assignFinalTurn = eagerMachineSetup.assign({
	turnId: ({ event }) => (event.type === 'FINAL_TURN_VALIDATE' ? event.turnId : 0),
	transcript: ({ event }) => (event.type === 'FINAL_TURN_VALIDATE' ? event.transcript : ''),
	controlBlock: ({ event }) => (event.type === 'FINAL_TURN_VALIDATE' ? event.controlBlock : ''),
	abort: () => new AbortController(),
})

const stashPendingValidate = eagerMachineSetup.assign({
	pendingValidate: ({ event }) =>
		event.type === 'FINAL_TURN_VALIDATE'
			? { transcript: event.transcript, controlBlock: event.controlBlock, turnId: event.turnId }
			: null,
})

const applyPendingValidate = eagerMachineSetup.assign({
	turnId: ({ context }) => context.pendingValidate!.turnId,
	transcript: ({ context }) => context.pendingValidate!.transcript,
	controlBlock: ({ context }) => context.pendingValidate!.controlBlock,
	abort: () => new AbortController(),
	pendingValidate: null,
})

const assignEagerDraft = eagerMachineSetup.assign({
	eagerDraft: ({ event }) => {
		if (!('output' in event) || event.output === null) return null
		const output = event.output as EagerPreparedResult
		return {
			agentResponse: output.agentResponse,
			userTranscript: output.userTranscript,
			controlBlock: output.controlBlock,
		}
	},
	eagerGeneratedAt: () => Date.now(),
	validatedTranscript: null,
	sink: ({ event }) => {
		if (!('output' in event) || event.output === null) return null
		return (event.output as EagerPreparedResult).sink
	},
	triggerSynthesisStart: ({ event }) => {
		if (!('output' in event) || event.output === null) return null
		return (event.output as EagerPreparedResult).triggerSynthesisStart
	},
	ttsPromise: ({ event }) => {
		if (!('output' in event) || event.output === null) return null
		return (event.output as EagerPreparedResult).ttsPromise
	},
})

const assignValidated = eagerMachineSetup.assign({
	eagerDraft: ({ context }) =>
		context.eagerDraft ? { ...context.eagerDraft, userTranscript: context.transcript } : context.eagerDraft,
	validatedTranscript: ({ context }) => context.transcript,
})

const cancelAndReset = eagerMachineSetup.enqueueActions(({ context, enqueue }) => {
	if (context.sink) {
		// Defensive teardown: once speculation is canceled/discarded we must
		// drop any buffered PCM and detach live forwarding hooks so stale
		// speculative audio cannot be replayed later.
		context.sink.forward = null
		context.sink.chunks.length = 0
		context.sink.done = true
	}
	if (context.sink || context.eagerDraft) enqueue('interruptSpecTts')
	if (context.abort) enqueue({ type: 'abortCurrent', params: { abort: context.abort } })
	enqueue(resetContext)
})

const recordMetric = (outcome: 'promoted' | 'discarded_diverged') =>
	eagerMachineSetup.enqueueActions(({ context, enqueue }) => {
		enqueue(
			sendParent({
				type: 'eager_promotion_metrics' as const,
				outcome,
				specTranscript: context.eagerDraft?.userTranscript ?? '',
				finalTranscript: context.transcript,
				durationMs: context.eagerStartedAt > 0 ? Date.now() - context.eagerStartedAt : 0,
			}),
		)
	})

export const eagerMachine = eagerMachineSetup.createMachine({
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
		validatedTranscript: null,
		sink: null,
		triggerSynthesisStart: null,
		ttsPromise: null,
		turnResumedSince: false,
		pendingValidate: null,
	},
	on: {
		CANCEL: {
			target: '.idle',
			actions: cancelAndReset,
		},
		MARK_TURN_RESUMED: {
			actions: eagerMachineSetup.assign({ turnResumedSince: true }),
		},
	},
	states: {
		idle: {
			on: {
				EAGER_TURN: {
					target: 'eagerGenerating',
					actions: assignEagerTurn,
				},
			},
		},

		eagerGenerating: {
			invoke: {
				id: 'eagerGeneration',
				src: 'eagerGeneration',
				input: ({ context }) => ({
					transcript: context.transcript,
					controlBlock: context.controlBlock,
					signal: context.abort!.signal,
				}),
				onDone: [
					{
						guard: ({ context, event }) => event.output !== null && context.pendingValidate !== null,
						target: 'validating',
						actions: [assignEagerDraft, applyPendingValidate],
					},
					{
						guard: ({ event }) => event.output !== null,
						target: 'ready',
						actions: assignEagerDraft,
					},
					{
						guard: ({ context }) => context.pendingValidate !== null,
						target: 'idle',
						actions: [resetContext, sendParent({ type: 'promotion_resolved' as const, promoted: false })],
					},
					{
						target: 'idle',
						actions: resetContext,
					},
				],
				onError: [
					{
						guard: ({ context }) => context.pendingValidate !== null,
						target: 'idle',
						actions: [resetContext, sendParent({ type: 'promotion_resolved' as const, promoted: false })],
					},
					{
						target: 'idle',
						actions: resetContext,
					},
				],
			},
			on: {
				EAGER_TURN: {
					target: 'eagerGenerating',
					reenter: true,
					actions: [cancelAndReset, assignEagerTurn],
				},
				FINAL_TURN_VALIDATE: {
					actions: stashPendingValidate,
				},
			},
		},

		ready: {
			on: {
				EAGER_TURN: {
					target: 'eagerGenerating',
					actions: [cancelAndReset, assignEagerTurn],
				},
				FINAL_TURN_VALIDATE: {
					target: 'validating',
					actions: assignFinalTurn,
				},
			},
		},

		validating: {
			on: {
				FINAL_TURN_VALIDATE: {
					target: 'validating',
					reenter: true,
					actions: assignFinalTurn,
				},
			},
			invoke: {
				id: 'finalValidator',
				src: 'finalValidator',
				input: ({ context }) => ({
					basisTranscript: context.eagerDraft?.userTranscript ?? '',
					finalTranscript: context.transcript,
					draftResponse: context.eagerDraft?.agentResponse ?? null,
					signal: context.abort!.signal,
				}),
				onDone: [
					{
						guard: ({ event }) => event.output.valid,
						target: 'ready',
						actions: [
							assignValidated,
							recordMetric('promoted'),
							sendParent({ type: 'promotion_resolved' as const, promoted: true }),
						],
					},
					{
						target: 'idle',
						actions: [
							recordMetric('discarded_diverged'),
							cancelAndReset,
							sendParent({ type: 'promotion_resolved' as const, promoted: false }),
						],
					},
				],
				onError: {
					target: 'idle',
					actions: [
						recordMetric('discarded_diverged'),
						cancelAndReset,
						sendParent({ type: 'promotion_resolved' as const, promoted: false }),
					],
				},
			},
		},
	},
})

export type EagerMachine = typeof eagerMachine
export type EagerMachineActor = ActorRefFrom<EagerMachine>
