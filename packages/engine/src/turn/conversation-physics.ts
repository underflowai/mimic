/**
 * Adaptive conversation physics (v1) — per-caller heuristic controller.
 *
 * Different callers speak with different rhythms. The engine's fixed
 * timing constants are tuned for the median caller, which means they
 * interrupt slow, pause-prone speakers. The signals that identify such a
 * caller are already flowing: Flux `TurnResumed` (an end-of-turn call
 * that Flux itself walked back — the caller was mid-utterance) and
 * mid-thought interrupts (the agent started speaking and was immediately
 * barged, or a soft pause escalated because the caller kept going).
 *
 * v1 is a one-way latch: once the evidence threshold is crossed the call
 * switches to slow-caller physics — Flux waits longer before declaring
 * end of turn, the soft-pause escalation timer widens, the silence
 * watchdog stretches, early commit is disabled, and one line is injected
 * into every subsequent control block. No un-latching mid-call: a caller
 * who pauses is a caller who pauses.
 */

export interface TurnTunables {
	/** Added to the base soft-pause substantive-speech escalation timer. */
	substantiveSpeechExtraMs: number
	/** Added to the silence-watchdog idle delay. */
	silenceWatchdogExtraMs: number
	/** When true, the early-commit fast path must not fire. */
	earlyCommitDisabled: boolean
	/** Line appended to every control block, or null. */
	controlBlockLine: string | null
}

export interface ConversationPhysicsDeps {
	/** Applies transcriber-level knobs when the slow-caller latch fires. */
	configureTranscriber: (opts: { eotThreshold?: number; eotTimeoutMs?: number }) => void
	onActivate?: (evidence: { turnResumedCount: number; midThoughtInterrupts: number }) => void
}

/**
 * Two Flux walk-backs, or one soft-pause escalation (the caller talked
 * straight through a pause — the clearest "you stepped on me" signal), or
 * two early barges. Single weak events are ambiguous; pairs are a pattern.
 */
const turnResumedThreshold = 2
const escalationThreshold = 1
const earlyBargeThreshold = 2

/** A barge within this much sent audio counts as early — the agent had
 * barely started speaking, so the caller almost certainly was not done. */
const earlyBargeSentMsCeiling = 1200

const slowCallerFlux = { eotThreshold: 0.65, eotTimeoutMs: 3000 }

const slowCallerTunables: TurnTunables = {
	substantiveSpeechExtraMs: 250,
	silenceWatchdogExtraMs: 3000,
	earlyCommitDisabled: true,
	controlBlockLine:
		'This caller pauses mid-sentence and takes their time — never rush them, leave room after their sentences, and keep your own turns unhurried.',
}

const defaultTunables: TurnTunables = {
	substantiveSpeechExtraMs: 0,
	silenceWatchdogExtraMs: 0,
	earlyCommitDisabled: false,
	controlBlockLine: null,
}

export function createConversationPhysics(deps: ConversationPhysicsDeps) {
	let turnResumedCount = 0
	let escalationCount = 0
	let earlyBargeCount = 0
	let slowCallerLatched = false

	function maybeLatch() {
		if (slowCallerLatched) return
		const crossed =
			turnResumedCount >= turnResumedThreshold ||
			escalationCount >= escalationThreshold ||
			earlyBargeCount >= earlyBargeThreshold
		if (!crossed) return
		slowCallerLatched = true
		deps.configureTranscriber(slowCallerFlux)
		deps.onActivate?.({ turnResumedCount, midThoughtInterrupts: escalationCount + earlyBargeCount })
	}

	return {
		noteTurnResumed() {
			turnResumedCount++
			maybeLatch()
		},
		/**
		 * Feed interrupted-turn outcomes. `sentMs` is how much agent audio
		 * had been sent when the caller took the floor; `escalatedFromSoftPause`
		 * marks substantive-speech escalations (the caller talked through the
		 * pause — the agent had stepped on an unfinished thought).
		 */
		noteInterrupt(info: { sentMs: number; escalatedFromSoftPause: boolean }) {
			if (info.escalatedFromSoftPause) {
				escalationCount++
			} else if (info.sentMs > 0 && info.sentMs < earlyBargeSentMsCeiling) {
				earlyBargeCount++
			} else {
				return
			}
			maybeLatch()
		},
		isSlowCaller() {
			return slowCallerLatched
		},
		getTunables(): TurnTunables {
			return slowCallerLatched ? slowCallerTunables : defaultTunables
		},
	}
}

export type ConversationPhysics = ReturnType<typeof createConversationPhysics>
