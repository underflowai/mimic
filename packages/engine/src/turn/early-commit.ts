/**
 * Early commit on converging evidence.
 *
 * Today Flux `EndOfTurn` (eot_threshold=0.5) is a hard gate on every turn:
 * even when the caller has clearly stopped, the engine idles until Flux
 * crosses its confidence threshold. This controller commits the turn early
 * when three independent signals converge:
 *
 *   1. local VAD reports silence (and it has held for the guard interval),
 *   2. an eager draft is ready — Flux already fired `EagerEndOfTurn` for
 *      this utterance, i.e. its own model considered the turn plausibly
 *      over, and speculation has a validated response synthesized, and
 *   3. the caller has said nothing since the eager boundary (the latest
 *      partial matches the draft's basis transcript).
 *
 * When all three hold, the controller injects a synthetic
 * `caller_turn_complete` carrying the eager basis transcript. Dispatch then
 * promotes the presynthesized draft instantly, and the runtime's duplicate
 * suppression swallows the real Flux `EndOfTurn` when it arrives with the
 * same normalized transcript. Flux becomes confirmation, not gate.
 *
 * A wrong early commit is exactly the failure the soft-pause /
 * `TurnResumed` / heard-portion machinery already recovers from, so the
 * controller stays conservative but not paranoid:
 *
 *   - after open questions ("How did that go?") it is disabled — silence
 *     is thinking, not completion (question-aware boundaries),
 *   - slow-caller physics disables it outright,
 *   - any speech signal (VAD start, turn start/resume, longer partial)
 *     cancels the pending commit.
 */

export type EarlyCommitBlockReason =
	| 'in_turn'
	| 'closing'
	| 'caller_active'
	| 'no_draft'
	| 'partial_mismatch'
	| 'guard_not_elapsed'

export interface EarlyCommitWorld {
	/** Machine currently executing a turn — never early-commit into it. */
	machineInTurn: boolean
	isClosing: boolean
	/** Eager machine sits in `ready` with a prepared draft. */
	eagerReady: boolean
	/** Transcript the eager draft was generated from. */
	eagerBasisTranscript: string | null
}

export interface EarlyCommitDeps {
	/** Guard interval after VAD end, or null when early commit is disabled
	 * (open-question patience, slow-caller physics). Read at every check. */
	guardMsFor: () => number | null
	getWorld: () => EarlyCommitWorld
	commit: (transcript: string, confidence: number) => void
	onFired?: (info: { transcript: string; sinceVadEndMs: number }) => void
	onBlocked?: (reason: EarlyCommitBlockReason) => void
	now?: () => number
}

export function normalizeTranscript(transcript: string) {
	return transcript
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

export function createEarlyCommitController(deps: EarlyCommitDeps) {
	const now = deps.now ?? Date.now

	let lastVadEndAt = 0
	let vadActive = false
	/** Latest cumulative Flux partial for the current utterance. */
	let lastPartial = ''
	let lastEagerConfidence = 0
	let guardTimer: ReturnType<typeof setTimeout> | null = null
	let closed = false
	/** True while the controller itself is injecting the synthetic final. */
	let firing = false

	function cancelGuardTimer() {
		if (guardTimer === null) return
		clearTimeout(guardTimer)
		guardTimer = null
	}

	function blocked(reason: EarlyCommitBlockReason) {
		deps.onBlocked?.(reason)
	}

	/** Full eligibility re-check; fires the commit when everything holds. */
	function tryFire() {
		if (closed || firing) return
		const guardMs = deps.guardMsFor()
		if (guardMs === null) return
		if (vadActive) return blocked('caller_active')
		if (lastVadEndAt <= 0) return

		const sinceVadEnd = now() - lastVadEndAt
		if (sinceVadEnd < guardMs) return blocked('guard_not_elapsed')

		const world = deps.getWorld()
		if (world.isClosing) return blocked('closing')
		if (world.machineInTurn) return blocked('in_turn')
		if (!world.eagerReady || !world.eagerBasisTranscript?.trim()) return blocked('no_draft')

		const basis = normalizeTranscript(world.eagerBasisTranscript)
		if (!basis) return blocked('no_draft')
		if (lastPartial && normalizeTranscript(lastPartial) !== basis) return blocked('partial_mismatch')

		firing = true
		try {
			deps.commit(world.eagerBasisTranscript, lastEagerConfidence)
		} finally {
			firing = false
		}
		deps.onFired?.({ transcript: world.eagerBasisTranscript, sinceVadEndMs: sinceVadEnd })
		cancelGuardTimer()
		lastVadEndAt = 0
		lastPartial = ''
	}

	function scheduleGuardCheck() {
		cancelGuardTimer()
		const guardMs = deps.guardMsFor()
		if (guardMs === null || closed) return
		const elapsed = now() - lastVadEndAt
		const waitMs = Math.max(guardMs - elapsed, 0)
		guardTimer = setTimeout(() => {
			guardTimer = null
			tryFire()
		}, waitMs)
		guardTimer.unref?.()
	}

	return {
		vadSpeechStart() {
			vadActive = true
			cancelGuardTimer()
		},
		vadSpeechEnd() {
			if (firing) return
			vadActive = false
			lastVadEndAt = now()
			scheduleGuardCheck()
		},
		callerUpdate(transcript: string) {
			if (firing) return
			if (transcript.trim()) lastPartial = transcript
		},
		callerEagerTurn(transcript: string, confidence: number) {
			if (firing) return
			lastPartial = transcript
			lastEagerConfidence = confidence
			// The draft for this eager turn is not ready yet; the eager-ready
			// hook re-checks once it is.
		},
		callerTurnStart() {
			if (firing) return
			cancelGuardTimer()
			lastPartial = ''
		},
		callerTurnResumed() {
			if (firing) return
			cancelGuardTimer()
		},
		/** Real Flux final (or any accepted turn) — nothing pending anymore. */
		callerTurnComplete() {
			if (firing) return
			cancelGuardTimer()
			lastPartial = ''
		},
		/** Eager machine reached `ready` — the draft may have finished after
		 * the guard window already elapsed in silence. */
		eagerDraftReady() {
			if (closed || firing) return
			if (vadActive || lastVadEndAt <= 0) return
			const guardMs = deps.guardMsFor()
			if (guardMs === null) return
			if (now() - lastVadEndAt >= guardMs) {
				tryFire()
			} else {
				scheduleGuardCheck()
			}
		},
		close() {
			closed = true
			cancelGuardTimer()
		},
	}
}

export type EarlyCommitController = ReturnType<typeof createEarlyCommitController>
