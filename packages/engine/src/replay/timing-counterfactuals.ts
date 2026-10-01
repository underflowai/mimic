/**
 * Timing counterfactuals over recorded call event logs.
 *
 * None of this needs a simulation. "Was this soft pause a hiccup or words?",
 * "how long after VAD end did Flux take to finalize, and would the partial at
 * +200ms have matched?", "how long do callers take to answer?" are all
 * directly computable from the recorded VAD / transcript / playback
 * timelines. Every function is pure: feed it one call's events, or run the
 * extractors over a corpus and sweep thresholds on the pooled episodes.
 */

import { classifyCallerSpeech, type CallerSpeechKind } from '../turn/caller-speech.js'
import { callMachineActorId, eventConfidence, eventTranscript, type CallEventRecord } from './event-log.js'

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

export interface SeriesSummary {
	count: number
	p50: number
	p95: number
	min: number
	max: number
	mean: number
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0
	const index = Math.min(Math.ceil(sorted.length * p) - 1, sorted.length - 1)
	return sorted[Math.max(0, index)]!
}

export function summarizeSeries(values: number[]): SeriesSummary {
	if (values.length === 0) return { count: 0, p50: 0, p95: 0, min: 0, max: 0, mean: 0 }
	const sorted = [...values].sort((a, b) => a - b)
	return {
		count: values.length,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		min: sorted[0]!,
		max: sorted[sorted.length - 1]!,
		mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
	}
}

/** Caller and VAD events as the call machine received them (not the copies forwarded to children). */
function isCallerInput(event: CallEventRecord): boolean {
	return event.actor === callMachineActorId || event.actor === undefined
}

const callerTranscriptTypes = new Set([
	'caller_turn_start',
	'caller_update',
	'caller_eager_turn',
	'caller_turn_resumed',
	'caller_turn_complete',
])

// ---------------------------------------------------------------------------
// Soft-pause episodes: caller speech while agent audio is live
// ---------------------------------------------------------------------------

export interface BargeEpisode {
	/** When VAD saw the caller start while the agent was speaking (ms offset). */
	startAtMs: number
	/** VAD speech duration. Infinity when no speech end was recorded. */
	durationMs: number
	/** ms from VAD start to the first transcriber words, or null for a VAD-only episode. */
	firstWordsAfterMs: number | null
	/** Everything the transcriber heard during the episode (plus a short tail). */
	words: string
	kind: CallerSpeechKind
	/** What the engine actually did. */
	outcome: 'interrupted' | 'resumed'
	turnId: number | null
}

/** Transcripts that arrive shortly after VAD end still belong to the episode. */
const episodeTailMs = 400

export function extractBargeEpisodes(events: CallEventRecord[]): BargeEpisode[] {
	const episodes: BargeEpisode[] = []
	let agentSpeaking = false
	let agentTurnId: number | null = null
	let open: {
		startAtMs: number
		endAtMs: number | null
		turnId: number | null
		interrupted: boolean
		words: Array<{ atMs: number; text: string }>
	} | null = null

	function close(endAtMs: number | null) {
		if (!open) return
		const within = open.words.filter((w) => endAtMs === null || w.atMs <= endAtMs + episodeTailMs)
		const words = within.length > 0 ? within[within.length - 1]!.text : ''
		episodes.push({
			startAtMs: open.startAtMs,
			durationMs: endAtMs === null ? Number.POSITIVE_INFINITY : endAtMs - open.startAtMs,
			firstWordsAfterMs: within.length > 0 ? within[0]!.atMs - open.startAtMs : null,
			words,
			kind: classifyCallerSpeech(words),
			outcome: open.interrupted ? 'interrupted' : 'resumed',
			turnId: open.turnId,
		})
		open = null
	}

	for (const event of events) {
		// Close the previous episode once its tail has elapsed, before this event can open a new one.
		if (open && open.endAtMs !== null && event.atMs > open.endAtMs + episodeTailMs) close(open.endAtMs)
		switch (event.type) {
			case 'first_audio_sent':
				agentSpeaking = true
				break
			case 'turn_outcome':
				agentSpeaking = false
				if (typeof event.data.turnId === 'number') agentTurnId = event.data.turnId
				if (open && event.data.kind === 'interrupted') open.interrupted = true
				break
			case 'interrupt':
				if (open) open.interrupted = true
				break
			case 'playback_confirmed':
				if (isCallerInput(event)) agentSpeaking = false
				break
			case 'vad_speech_start':
				if (!isCallerInput(event)) break
				if (agentSpeaking && !open)
					open = { startAtMs: event.atMs, endAtMs: null, turnId: agentTurnId, interrupted: false, words: [] }
				break
			case 'vad_speech_end':
				if (!isCallerInput(event) || !open) break
				open.endAtMs = event.atMs
				break
			default:
				if (open && isCallerInput(event) && callerTranscriptTypes.has(event.type)) {
					const text = eventTranscript(event).trim()
					if (text) open.words.push({ atMs: event.atMs, text })
				}
		}
	}
	if (open) close((open as { endAtMs: number | null }).endAtMs)
	return episodes
}

export interface SoftPauseSummary {
	episodes: number
	byKind: Record<CallerSpeechKind, { count: number; interrupted: number }>
	/** VAD-only episodes (no words ever arrived): how long they lasted. Calibrates `vadOnlyGraceMs`. */
	vadOnlyDurationsMs: SeriesSummary
	/** Worded episodes: how long after VAD start the first words arrived. Calibrates `substantiveSpeechMs`. */
	firstWordsAfterMs: SeriesSummary
}

export function summarizeSoftPauses(episodes: BargeEpisode[]): SoftPauseSummary {
	const byKind: SoftPauseSummary['byKind'] = {
		none: { count: 0, interrupted: 0 },
		backchannel: { count: 0, interrupted: 0 },
		speech: { count: 0, interrupted: 0 },
	}
	for (const episode of episodes) {
		byKind[episode.kind].count++
		if (episode.outcome === 'interrupted') byKind[episode.kind].interrupted++
	}
	return {
		episodes: episodes.length,
		byKind,
		vadOnlyDurationsMs: summarizeSeries(
			episodes.filter((e) => e.firstWordsAfterMs === null && Number.isFinite(e.durationMs)).map((e) => e.durationMs),
		),
		firstWordsAfterMs: summarizeSeries(
			episodes.filter((e) => e.firstWordsAfterMs !== null).map((e) => e.firstWordsAfterMs as number),
		),
	}
}

export interface ProbeWindowSweepRow {
	probeMs: number
	wordedEpisodes: number
	/** Words arrived inside the probe window: the pause decides on transcript evidence. */
	decidedOnWords: number
	/** Words arrived later: the pause would have fallen through to the VAD-only path first. */
	wordsTooLate: number
	vadOnlyEpisodes: number
	/** VAD-only episodes still active at the end of the probe window. */
	vadOnlyStillActive: number
}

/** "At probe window T, how many pauses get a transcript to decide on, and how many hiccups outlast T?" */
export function sweepProbeWindows(episodes: BargeEpisode[], probesMs: number[]): ProbeWindowSweepRow[] {
	const worded = episodes.filter((e) => e.firstWordsAfterMs !== null)
	const vadOnly = episodes.filter((e) => e.firstWordsAfterMs === null)
	return probesMs.map((probeMs) => ({
		probeMs,
		wordedEpisodes: worded.length,
		decidedOnWords: worded.filter((e) => (e.firstWordsAfterMs as number) <= probeMs).length,
		wordsTooLate: worded.filter((e) => (e.firstWordsAfterMs as number) > probeMs).length,
		vadOnlyEpisodes: vadOnly.length,
		vadOnlyStillActive: vadOnly.filter((e) => e.durationMs > probeMs).length,
	}))
}

// ---------------------------------------------------------------------------
// Utterances: how long Flux takes after VAD end, and what an early commit would have said
// ---------------------------------------------------------------------------

export interface UtteranceGroup {
	/** Last VAD speech end before the final transcript. */
	vadEndAtMs: number
	partials: Array<{ atMs: number; transcript: string }>
	final: { atMs: number; transcript: string; confidence: number | null }
}

export function normalizeTranscript(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Group caller events into utterances: `caller_turn_start` opens one, the
 * `caller_turn_complete` that follows is its final. Only utterances with a
 * VAD end before the final are kept, since the question is what happened in
 * the gap between the caller going quiet and Flux deciding.
 */
export function extractUtteranceGroups(events: CallEventRecord[]): UtteranceGroup[] {
	const groups: UtteranceGroup[] = []
	let partials: Array<{ atMs: number; transcript: string }> = []
	let lastVadEnd: number | null = null
	let inUtterance = false

	for (const event of events) {
		if (!isCallerInput(event)) continue
		switch (event.type) {
			case 'caller_turn_start':
				partials = []
				lastVadEnd = null
				inUtterance = true
				if (eventTranscript(event).trim()) partials.push({ atMs: event.atMs, transcript: eventTranscript(event) })
				break
			case 'caller_update':
			case 'caller_eager_turn':
			case 'caller_turn_resumed':
				if (inUtterance && eventTranscript(event).trim()) {
					partials.push({ atMs: event.atMs, transcript: eventTranscript(event) })
				}
				break
			case 'vad_speech_end':
				if (inUtterance) lastVadEnd = event.atMs
				break
			case 'caller_turn_complete': {
				if (!inUtterance) break
				const transcript = eventTranscript(event)
				if (transcript.trim() && lastVadEnd !== null && event.atMs >= lastVadEnd) {
					groups.push({
						vadEndAtMs: lastVadEnd,
						partials,
						final: { atMs: event.atMs, transcript, confidence: eventConfidence(event) },
					})
				}
				partials = []
				lastVadEnd = null
				inUtterance = false
				break
			}
		}
	}
	return groups
}

/** VAD end → Flux final, per utterance. The whole window is what an early commit could save. */
export function endpointingDelays(groups: UtteranceGroup[]): number[] {
	return groups.map((g) => g.final.atMs - g.vadEndAtMs)
}

export interface EarlyCommitSweepRow {
	guardMs: number
	utterances: number
	/** Guard elapsed before Flux with a non-empty partial available: the commit would have fired. */
	wouldFire: number
	/** Fired and the partial matched what Flux finalized. */
	confirmed: number
	/** Fired on a partial that differed from the final: the agent would have answered the wrong thing. */
	superseded: number
	supersededRate: number
	meanSavedMs: number
}

export function sweepEarlyCommitGuards(groups: UtteranceGroup[], guardsMs: number[]): EarlyCommitSweepRow[] {
	return guardsMs.map((guardMs) => {
		let wouldFire = 0
		let confirmed = 0
		let superseded = 0
		const savings: number[] = []
		for (const group of groups) {
			const fireAt = group.vadEndAtMs + guardMs
			if (fireAt >= group.final.atMs) continue
			const partial = [...group.partials].reverse().find((p) => p.atMs <= fireAt)
			if (!partial || !normalizeTranscript(partial.transcript)) continue
			wouldFire++
			if (normalizeTranscript(partial.transcript) === normalizeTranscript(group.final.transcript)) {
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
// Overlap signatures: what the one remaining lexical decision cost
// ---------------------------------------------------------------------------

export interface OverlapSignatures {
	/** The agent kept talking over the caller's words (`backchannel_resumed`). */
	resumes: number
	/** The same utterance grew into speech and the turn actor yielded after all. */
	revoked: number
	/** Resumed, then interrupted before the caller's next turn start for any other reason: resuming was wrong. */
	talkedOver: number
	/** End-of-turns dropped while the agent was still speaking. */
	droppedAcknowledgments: number
	/** End-of-turns that arrived after the agent finished and went to the director with the overlap hint. */
	overlapTurns: { total: number; answeredWithNothing: number; answered: number }
	/**
	 * A dropped acknowledgement, or an overlap turn the director answered with
	 * nothing, followed by a silence follow-up with no caller speech in
	 * between: the caller may have been waiting on an answer we never gave.
	 */
	lostAnswerCandidates: number
	samples: { resumedOver: string[]; revoked: string[]; dropped: string[]; lostAnswers: string[] }
}

const maxSamples = 25

function pushSample(samples: string[], text: string) {
	const trimmed = text.trim()
	if (trimmed && samples.length < maxSamples) samples.push(trimmed)
}

export function extractOverlapSignatures(events: CallEventRecord[]): OverlapSignatures {
	const out: OverlapSignatures = {
		resumes: 0,
		revoked: 0,
		talkedOver: 0,
		droppedAcknowledgments: 0,
		overlapTurns: { total: 0, answeredWithNothing: 0, answered: 0 },
		lostAnswerCandidates: 0,
		samples: { resumedOver: [], revoked: [], dropped: [], lostAnswers: [] },
	}
	// The utterance the active turn resumed over, until the caller's next turn start.
	let resume: { transcript: string; outcome: 'open' | 'committed' | 'interrupted'; revoked: boolean } | null = null
	// Transcript of an overlap turn whose director outcome has not arrived yet.
	let overlapTurn: string | null = null
	// Words we stayed quiet on; cleared as soon as the caller speaks again.
	let quietOn: string | null = null

	for (const event of events) {
		switch (event.type) {
			case 'backchannel_resumed': {
				if (!isCallerInput(event)) break
				resume = { transcript: eventTranscript(event), outcome: 'open', revoked: false }
				out.resumes++
				pushSample(out.samples.resumedOver, resume.transcript)
				break
			}
			case 'resume_revoked':
				out.revoked++
				pushSample(out.samples.revoked, eventTranscript(event))
				if (resume) resume.revoked = true
				break
			case 'turn_outcome': {
				const kind = event.data.kind
				const reason = event.data.reason
				if (kind === 'discarded' && reason === 'backchannel_handled') {
					out.droppedAcknowledgments++
					const words = resume?.transcript ?? ''
					pushSample(out.samples.dropped, words)
					quietOn = words
					// Its end-of-turn is handled; the machine has nothing left to hint.
					resume = null
					break
				}
				if (overlapTurn !== null) {
					out.overlapTurns.total++
					if (kind === 'discarded' && reason === 'empty_response') {
						out.overlapTurns.answeredWithNothing++
						quietOn = overlapTurn
					} else if (kind === 'committed' || kind === 'interrupted') {
						out.overlapTurns.answered++
					}
					overlapTurn = null
					break
				}
				if (resume && resume.outcome === 'open' && (kind === 'committed' || kind === 'interrupted')) {
					resume.outcome = kind
					if (kind === 'interrupted' && !resume.revoked) out.talkedOver++
				}
				break
			}
			case 'caller_turn_complete':
				if (!isCallerInput(event)) break
				// The agent finished over the acknowledgement; its end-of-turn is now a hinted turn.
				if (resume?.outcome === 'committed') overlapTurn = eventTranscript(event)
				break
			case 'caller_turn_start':
				if (!isCallerInput(event)) break
				resume = null
				overlapTurn = null
				quietOn = null
				break
			case 'vad_speech_start':
				if (isCallerInput(event)) quietOn = null
				break
			case 'silence_follow_up':
				if (quietOn !== null) {
					out.lostAnswerCandidates++
					pushSample(out.samples.lostAnswers, quietOn)
					quietOn = null
				}
				break
			default:
				break
		}
	}
	return out
}

export function mergeOverlapSignatures(parts: OverlapSignatures[]): OverlapSignatures {
	const merged = extractOverlapSignatures([])
	for (const part of parts) {
		merged.resumes += part.resumes
		merged.revoked += part.revoked
		merged.talkedOver += part.talkedOver
		merged.droppedAcknowledgments += part.droppedAcknowledgments
		merged.overlapTurns.total += part.overlapTurns.total
		merged.overlapTurns.answeredWithNothing += part.overlapTurns.answeredWithNothing
		merged.overlapTurns.answered += part.overlapTurns.answered
		merged.lostAnswerCandidates += part.lostAnswerCandidates
		for (const key of Object.keys(merged.samples) as Array<keyof OverlapSignatures['samples']>) {
			for (const sample of part.samples[key]) pushSample(merged.samples[key], sample)
		}
	}
	return merged
}

// ---------------------------------------------------------------------------
// Caller response gaps and end-of-turn confidence
// ---------------------------------------------------------------------------

/** Agent playback finished → caller started speaking. Calibrates the silence watchdog. */
export function extractCallerGaps(events: CallEventRecord[]): number[] {
	const gaps: number[] = []
	let playbackDoneAt: number | null = null
	for (const event of events) {
		if (!isCallerInput(event)) continue
		if (event.type === 'playback_confirmed') playbackDoneAt = event.atMs
		else if (event.type === 'vad_speech_start' && playbackDoneAt !== null) {
			gaps.push(event.atMs - playbackDoneAt)
			playbackDoneAt = null
		}
	}
	return gaps
}

export interface ConfidenceHistogram {
	finals: number
	/** Below the trailing-off floor: answered with the trailing-off hint. */
	low: number
	/** Timeout-forced territory between the floor and the EOT threshold. */
	middle: number
	/** At or above the EOT threshold: Flux was sure. */
	high: number
}

export function histogramEotConfidence(
	events: CallEventRecord[],
	floors: { low: number; high: number },
): ConfidenceHistogram {
	const histogram: ConfidenceHistogram = { finals: 0, low: 0, middle: 0, high: 0 }
	for (const event of events) {
		if (event.type !== 'caller_turn_complete' || !isCallerInput(event)) continue
		const confidence = eventConfidence(event)
		if (confidence === null) continue
		histogram.finals++
		if (confidence < floors.low) histogram.low++
		else if (confidence < floors.high) histogram.middle++
		else histogram.high++
	}
	return histogram
}
