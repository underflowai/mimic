/**
 * TurnStrategy — the pure selection function for turn-complete dispatch.
 *
 * `selectStrategy(input, world)` is a pure function that maps the full
 * state of the call into exactly one dispatch path. It folds together what
 * used to be scattered across the call machine:
 *   - the turn_complete guards (isClosing, softPaused, backchannelResumed),
 *   - the interrupted-last-turn carryover,
 *   - the eager-pipeline snapshot (idle / generating / ready / validating).
 *
 * Every branch maps to exactly one strategy kind (the machine builds
 * `first_turn` itself from the opening block). The `never` exhaustiveness
 * pattern at the end catches missed eager states at compile time.
 */

import type { EagerAudioSink } from '../intelligence/types.js'

export type TurnStrategy =
	| { kind: 'discard'; reason: 'closing' | 'backchannel_handled' }
	| { kind: 'defer'; reason: 'soft_paused' }
	| {
			kind: 'presynthesized'
			transcript: string
			agentResponse: string
			sink: EagerAudioSink
			ttsPromise: Promise<void> | null
			triggerSynthesisStart: (() => void) | null
			generationStartedAt: number
	  }
	| {
			kind: 'fresh'
			transcript: string
			controlBlock: string
			racingPromotion?: boolean
	  }
	| {
			kind: 'first_turn'
			openingBlock: string
	  }

export type EagerStateValue = 'idle' | 'eagerGenerating' | 'ready' | 'validating'

export interface EagerSnapshot {
	value: EagerStateValue
	context: {
		turnId: number
		eagerDraft: {
			agentResponse: string
			userTranscript: string
			controlBlock: string
		} | null
		eagerGeneratedAt: number
		sink: EagerAudioSink | null
		ttsPromise: Promise<void> | null
		triggerSynthesisStart: (() => void) | null
		eagerStartedAt: number
		turnResumedSince: boolean
		validatedTranscript: string | null
	}
}

export interface WorldSnapshot {
	isClosing: boolean
	inSoftPause: boolean
	backchannelResumedPending: boolean
	lastTurnWasInterrupted: boolean
	eagerSnapshot: EagerSnapshot | null
}

export interface CallerCompleteInput {
	transcript: string
	confidence: number
	controlBlock: string
	/**
	 * The end-of-turn was forced by the silence timeout at low confidence.
	 * The control block carries a "caller may not be done" hint that the
	 * eager draft never saw, so the draft must not be reused.
	 */
	trailingOff?: boolean
}

export function selectStrategy(input: CallerCompleteInput, world: WorldSnapshot) {
	if (world.isClosing) {
		return { kind: 'discard', reason: 'closing' } as const
	}

	if (world.inSoftPause) {
		return { kind: 'defer', reason: 'soft_paused' } as const
	}

	if (world.backchannelResumedPending) {
		return { kind: 'discard', reason: 'backchannel_handled' } as const
	}

	if (world.lastTurnWasInterrupted || input.trailingOff) {
		return { kind: 'fresh', transcript: input.transcript, controlBlock: input.controlBlock } as const
	}

	const eager = world.eagerSnapshot
	if (!eager || eager.value === 'idle') {
		return { kind: 'fresh', transcript: input.transcript, controlBlock: input.controlBlock } as const
	}

	if (eager.value === 'ready') {
		const ctx = eager.context
		const transcriptMatchesEager = ctx.eagerDraft?.userTranscript === input.transcript
		if (transcriptMatchesEager && ctx.sink && ctx.eagerDraft) {
			return {
				kind: 'presynthesized',
				transcript: input.transcript,
				agentResponse: ctx.eagerDraft.agentResponse,
				sink: ctx.sink,
				ttsPromise: ctx.ttsPromise,
				triggerSynthesisStart: ctx.triggerSynthesisStart,
				generationStartedAt: ctx.eagerStartedAt,
			} as const
		}
		return {
			kind: 'fresh',
			transcript: input.transcript,
			controlBlock: input.controlBlock,
			racingPromotion: true,
		} as const
	}

	if (eager.value === 'eagerGenerating') {
		return {
			kind: 'fresh',
			transcript: input.transcript,
			controlBlock: input.controlBlock,
			racingPromotion: true,
		} as const
	}

	if (eager.value === 'validating') {
		return {
			kind: 'fresh',
			transcript: input.transcript,
			controlBlock: input.controlBlock,
			racingPromotion: true,
		} as const
	}

	const _exhaustive: never = eager.value
	return _exhaustive
}
