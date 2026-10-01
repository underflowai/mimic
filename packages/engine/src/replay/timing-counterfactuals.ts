/**
 * Timing counterfactuals over recorded call event logs.
 *
 * These need no simulation: questions like "would this interrupt have
 * resolved as a short pause at substantiveSpeechMs=500?" or "how much
 * would a 200ms early-commit guard have saved, and how often would the
 * committed transcript have been wrong?" are directly computable from
 * the recorded VAD/transcript/playback timelines.
 *
 * Every function here is pure — feed it one call's events or a whole
 * corpus (concatenated per call) and sweep thresholds offline instead of
 * guessing constants.
 */

import { normalizeTranscript } from '../turn/early-commit.js'
import { eventTranscript, type CallEventRecord } from './event-log.js'

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0
	const index = Math.min(Math.ceil(sorted.length * p) - 1, sorted.length - 1)
	return sorted[Math.max(0, index)]
}

export interface SeriesSummary {
	count: number
	p50: number
	p95: number
	min: number
	max: number
	mean: number
}

export function summarizeSeries(values: number[]): SeriesSummary {
	if (values.length === 0) return { count: 0, p50: 0, p95: 0, min: 0, max: 0, mean: 0 }
	const sorted = [...values].sort((a, b) => a - b)
	return {
		count: values.length,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		min: sorted[0],
		max: sorted[sorted.length - 1],
		mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
	}
}

// ---------------------------------------------------------------------------
// Barge episodes → substantive-speech threshold sweep
// ---------------------------------------------------------------------------

export interface BargeEpisode {
	/** When the caller started speaking over agent audio (ms offset). */
	speechStartAtMs: number
	/** How long the caller kept speaking. Infinity when no speech end was recorded. */
	speechDurationMs: number
	turnId: number | null
}

/**
 * Extract every episode where the caller started speaking while agent
 * audio was live (the soft-pause trigger condition).
 */
export function extractBargeEpisodes(events: CallEventRecord[]): BargeEpisode[] {
	const episodes: BargeEpisode[] = []
	let agentSpeakingSince: number | null = null
	let agentTurnId: number | null = null
	let openSpeechStart: { atMs: number; turnId: number | null } | null = null

	for (const event of events) {
		switch (event.type) {
			case 'agent_first_audio':
				agentSpeakingSince = event.atMs
				agentTurnId = typeof event.data.turnId === 'number' ? event.data.turnId : null
				break
			case 'agent_playback_complete':
				agentSpeakingSince = null
				break
			case 'turn_outcome': {
				// Interrupts end the agent's audio too.
				if (event.data.kind === 'interrupted') agentSpeakingSince = null
				break
			}
			case 'vad_speech_start':
				if (agentSpeakingSince !== null) {
					openSpeechStart = { atMs: event.atMs, turnId: agentTurnId }
				}
				break
			case 'vad_speech_end':
				if (openSpeechStart) {
					episodes.push({
						speechStartAtMs: openSpeechStart.atMs,
						speechDurationMs: event.atMs - openSpeechStart.atMs,
						turnId: openSpeechStart.turnId,
					})
					openSpeechStart = null
				}
				break
		}
	}
	if (openSpeechStart) {
		episodes.push({
			speechStartAtMs: openSpeechStart.atMs,
			speechDurationMs: Number.POSITIVE_INFINITY,
			turnId: openSpeechStart.turnId,
		})
	}
	return episodes
}

export interface SubstantiveSpeechSweepRow {
	thresholdMs: number
	episodes: number
	/** Episodes where the caller stopped before the threshold — soft pause resolves, agent resumes. */
	wouldHold: number
	/** Episodes where the caller kept going — escalate to a real interrupt. */
	wouldEscalate: number
	escalationRate: number
}

/**
 * "Would this interrupt have resolved as a short pause at
 * substantiveSpeechMs=T?" for every recorded barge episode, swept across
 * candidate thresholds.
 */
export function analyzeSubstantiveSpeechThresholds(
	events: CallEventRecord[],
	thresholdsMs: number[],
): SubstantiveSpeechSweepRow[] {
	const episodes = extractBargeEpisodes(events)
	return thresholdsMs.map((thresholdMs) => {
		const wouldHold = episodes.filter((e) => e.speechDurationMs < thresholdMs).length
		const wouldEscalate = episodes.length - wouldHold
		return {
			thresholdMs,
			episodes: episodes.length,
			wouldHold,
			wouldEscalate,
			escalationRate: episodes.length > 0 ? wouldEscalate / episodes.length : 0,
		}
	})
}

// ---------------------------------------------------------------------------
// Utterances → early-commit guard sweep
// ---------------------------------------------------------------------------

interface UtteranceGroup {
	/** Last VAD speech end before the final transcript. */
	vadEndAtMs: number
	/** Partial transcripts (caller_update / caller_eager_turn) with timestamps. */
	partials: Array<{ atMs: number; transcript: string }>
	final: { atMs: number; transcript: string }
}

/**
 * Group caller events into utterances: caller_turn_start opens a group,
 * the last caller_turn_complete before the next caller_turn_start is the
 * final. Early-commit synthetic finals (immediately preceded by
 * early_commit_fired) are excluded so the analysis always compares
 * against what Flux actually settled on.
 */
export function extractUtteranceGroups(events: CallEventRecord[]): UtteranceGroup[] {
	const groups: UtteranceGroup[] = []
	let partials: Array<{ atMs: number; transcript: string }> = []
	let lastVadEnd: number | null = null
	let pendingFinal: { atMs: number; transcript: string } | null = null
	let lastEventWasEarlyCommitFire = false
	let inUtterance = false

	function flush() {
		if (pendingFinal && lastVadEnd !== null && pendingFinal.atMs >= lastVadEnd) {
			groups.push({ vadEndAtMs: lastVadEnd, partials, final: pendingFinal })
		}
		partials = []
		lastVadEnd = null
		pendingFinal = null
		inUtterance = false
	}

	for (const event of events) {
		const wasEarlyCommitFire = lastEventWasEarlyCommitFire
		lastEventWasEarlyCommitFire = event.type === 'early_commit_fired'

		switch (event.type) {
			case 'caller_turn_start':
				flush()
				inUtterance = true
				if (eventTranscript(event).trim()) {
					partials.push({ atMs: event.atMs, transcript: eventTranscript(event) })
				}
				break
			case 'caller_update':
			case 'caller_eager_turn':
				if (!inUtterance) break
				if (eventTranscript(event).trim()) {
					partials.push({ atMs: event.atMs, transcript: eventTranscript(event) })
				}
				break
			case 'vad_speech_end':
				if (inUtterance) lastVadEnd = event.atMs
				break
			case 'caller_turn_complete': {
				if (!inUtterance) break
				// Synthetic commit fired by the early-commit controller — skip;
				// the real Flux final (or the next utterance) follows.
				if (wasEarlyCommitFire) break
				const transcript = eventTranscript(event)
				if (transcript.trim()) pendingFinal = { atMs: event.atMs, transcript }
				break
			}
		}
	}
	flush()
	return groups
}

export interface EarlyCommitSweepRow {
	guardMs: number
	utterances: number
	/** Guard elapsed with a non-empty partial available — the commit would have fired. */
	wouldFire: number
	/** Fired and the partial matched the eventual Flux final. */
	confirmed: number
	/** Fired but the final differed — the agent would have answered the wrong thing. */
	superseded: number
	supersededRate: number
	/** Mean ms saved on confirmed commits (actual EOT wait minus the guard). */
	meanSavedMs: number
}

/**
 * Sweep early-commit guard intervals: at vadEnd+guard, would the partial
 * transcript have matched what Flux eventually finalized, and how much
 * waiting would firing have saved?
 */
export function analyzeEarlyCommitGuards(events: CallEventRecord[], guardsMs: number[]): EarlyCommitSweepRow[] {
	const groups = extractUtteranceGroups(events)
	return guardsMs.map((guardMs) => {
		let wouldFire = 0
		let confirmed = 0
		let superseded = 0
		const savings: number[] = []

		for (const group of groups) {
			const fireAt = group.vadEndAtMs + guardMs
			if (fireAt >= group.final.atMs) continue // Flux beat the guard; early commit buys nothing
			const partialAtGuard = [...group.partials].reverse().find((p) => p.atMs <= fireAt)
			if (!partialAtGuard || !normalizeTranscript(partialAtGuard.transcript)) continue
			wouldFire++
			if (normalizeTranscript(partialAtGuard.transcript) === normalizeTranscript(group.final.transcript)) {
				confirmed++
				savings.push(group.final.atMs - fireAt)
			} else {
				superseded++
			}
		}

		return {
			guardMs,
			utterances: groups.length,
			wouldFire,
			confirmed,
			superseded,
			supersededRate: wouldFire > 0 ? superseded / wouldFire : 0,
			meanSavedMs: savings.length > 0 ? Math.round(savings.reduce((a, b) => a + b, 0) / savings.length) : 0,
		}
	})
}

// ---------------------------------------------------------------------------
// Caller response gaps → silence watchdog calibration
// ---------------------------------------------------------------------------

/** Raw gaps between agent playback end and the caller's next speech start. */
export function extractCallerGaps(events: CallEventRecord[]): number[] {
	const gaps: number[] = []
	let playbackCompletedAt: number | null = null

	for (const event of events) {
		if (event.type === 'agent_playback_complete') {
			playbackCompletedAt = event.atMs
		} else if (event.type === 'vad_speech_start' && playbackCompletedAt !== null) {
			gaps.push(event.atMs - playbackCompletedAt)
			playbackCompletedAt = null
		}
	}
	return gaps
}

/**
 * Distribution of how long callers take to start speaking after the
 * agent finishes. Directly calibrates the silence watchdog delays.
 */
export function summarizeCallerGaps(events: CallEventRecord[]): SeriesSummary {
	return summarizeSeries(extractCallerGaps(events))
}
