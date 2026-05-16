import type { InterruptContext } from '../intelligence/types.js'

export type InterruptReason =
	| 'caller_started_speaking'
	| 'call_ended'
	| 'new_turn_started'
	| 'caller_substantive_speech'

// ── Turn outcome ─────────────────────────────────────────────────────

export interface CommittedTurn {
	turnId: number
	userTranscript: string
	agentResponse: string
	endCallRequested: boolean
}

export type TurnOutcome =
	| {
			kind: 'committed'
			turnId: number
			turn: CommittedTurn
			interruptContext: null
	  }
	| {
			kind: 'interrupted'
			turnId: number
			transcript: string
			interruptContext: InterruptContext
			reason: InterruptReason
	  }
	| {
			kind: 'discarded'
			turnId: number
			reason: 'closing' | 'backchannel_handled' | 'commit_error' | 'empty_response' | 'failed'
	  }
	| {
			kind: 'deferred'
			turnId: number
			reason: 'soft_paused'
	  }

// ── Re-exports ───────────────────────────────────────────────────────

export type { PlaybackWaitSendEvent } from './actors/playback-wait-actor.js'
export type { CallerCompleteInput, EagerSnapshot, EagerStateValue, TurnStrategy, WorldSnapshot } from './strategy.js'
export type { TurnActorMachine, TurnActorSnapshot, TurnActorStateValue } from './turn-actor.js'
