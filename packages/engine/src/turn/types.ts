import type { InterruptContext } from '../intelligence/types.js'
import type { WordTiming } from '../shared/audio-pacing.js'

export type InterruptReason =
	| 'caller_started_speaking'
	| 'call_ended'
	| 'new_turn_started'
	| 'caller_substantive_speech'

/** Why the engine asked the host to hang up. */
export type HangupSource = 'silence' | 'end_call_tag'

// ── Playback ─────────────────────────────────────────────────────────

/** What the caller has heard of the active turn, read at interrupt time. */
export interface PlaybackSnapshot {
	/** Agent audio handed to the transport. */
	sentMs: number
	/** Agent audio that has actually reached the caller: sent minus the transport's unplayed queue. */
	playedMs: number
	/** TTS word timings for the turn's audio so far. */
	words: readonly WordTiming[]
}

export const emptyPlaybackSnapshot: PlaybackSnapshot = { sentMs: 0, playedMs: 0, words: [] }

// ── Turn outcome ─────────────────────────────────────────────────────

export interface CommittedTurn {
	turnId: number
	userTranscript: string
	agentResponse: string
	endCallRequested: boolean
	/** The director ended its reply with `[hold]`: the caller asked us to wait. */
	holdRequested: boolean
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
