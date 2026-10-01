import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { CallEventRecord } from './event-log.js'
import {
	endpointingDelays,
	extractBargeEpisodes,
	extractCallerGaps,
	extractOverlapSignatures,
	extractUtteranceGroups,
	histogramEotConfidence,
	mergeOverlapSignatures,
	normalizeTranscript,
	summarizeSeries,
	summarizeSoftPauses,
	sweepEarlyCommitGuards,
	sweepProbeWindows,
} from './timing-counterfactuals.js'

function log(entries: Array<[number, string, Record<string, unknown>?, string?]>): CallEventRecord[] {
	return entries.map(([atMs, type, data = {}, actor = 'call'], seq) => ({ seq, atMs, type, actor, data }))
}

describe('timing counterfactuals: series', () => {
	it('summarizes percentiles', () => {
		const s = summarizeSeries([100, 200, 300, 400, 1_000])
		assert.equal(s.count, 5)
		assert.equal(s.p50, 300)
		assert.equal(s.p95, 1_000)
		assert.equal(s.min, 100)
		assert.equal(s.max, 1_000)
		assert.equal(s.mean, 400)
		assert.equal(summarizeSeries([]).count, 0)
	})
})

describe('timing counterfactuals: soft-pause episodes', () => {
	const events = log([
		[0, 'caller_turn_complete', { transcript: 'can you move it', confidence: 0.9 }],
		[400, 'first_audio_sent', { at: 400 }, 'turnActor'],
		// A VAD hiccup: 180ms of "speech", no words ever.
		[1_000, 'vad_speech_start'],
		[1_180, 'vad_speech_end'],
		// A backchannel: words arrive 220ms after VAD start; engine resumed.
		[2_000, 'vad_speech_start'],
		[2_220, 'caller_update', { transcript: 'mm-hmm', confidence: 0.6 }],
		[2_300, 'vad_speech_end'],
		// Real speech: words at +350ms; engine interrupted.
		[4_000, 'vad_speech_start'],
		[4_350, 'caller_update', { transcript: 'actually wait', confidence: 0.7 }],
		[4_500, 'caller_update', { transcript: 'actually wait I need to change the day', confidence: 0.8 }],
		[4_600, 'interrupt', { reason: 'caller_speech' }, 'turnActor'],
		[4_650, 'turn_outcome', { kind: 'interrupted', turnId: 1, reason: 'caller_speech' }, undefined],
		[4_700, 'vad_speech_end'],
		[6_000, 'caller_turn_complete', { transcript: 'actually wait I need to change the day', confidence: 0.95 }],
	])

	it('extracts episodes with timing, words, classification, and the actual outcome', () => {
		const episodes = extractBargeEpisodes(events)
		assert.equal(episodes.length, 3)

		assert.equal(episodes[0]!.firstWordsAfterMs, null)
		assert.equal(episodes[0]!.durationMs, 180)
		assert.equal(episodes[0]!.kind, 'none')
		assert.equal(episodes[0]!.outcome, 'resumed')

		assert.equal(episodes[1]!.firstWordsAfterMs, 220)
		assert.equal(episodes[1]!.kind, 'backchannel')
		assert.equal(episodes[1]!.outcome, 'resumed')

		assert.equal(episodes[2]!.firstWordsAfterMs, 350)
		assert.equal(episodes[2]!.words, 'actually wait I need to change the day')
		assert.equal(episodes[2]!.kind, 'speech')
		assert.equal(episodes[2]!.outcome, 'interrupted')
	})

	it('ignores caller speech while the agent is silent', () => {
		const quiet = log([
			[0, 'vad_speech_start'],
			[500, 'caller_update', { transcript: 'hello', confidence: 0.5 }],
			[800, 'vad_speech_end'],
		])
		assert.equal(extractBargeEpisodes(quiet).length, 0)
	})

	it('summarizes by kind and sweeps probe windows', () => {
		const episodes = extractBargeEpisodes(events)
		const summary = summarizeSoftPauses(episodes)
		assert.equal(summary.episodes, 3)
		assert.equal(summary.byKind.none.count, 1)
		assert.equal(summary.byKind.backchannel.count, 1)
		assert.equal(summary.byKind.speech.count, 1)
		assert.equal(summary.byKind.speech.interrupted, 1)
		assert.equal(summary.vadOnlyDurationsMs.p50, 180)
		assert.equal(summary.firstWordsAfterMs.count, 2)

		const sweep = sweepProbeWindows(episodes, [200, 300, 400])
		assert.deepEqual(
			sweep.map((r) => [r.probeMs, r.decidedOnWords, r.wordsTooLate, r.vadOnlyStillActive]),
			[
				[200, 0, 2, 0],
				[300, 1, 1, 0],
				[400, 2, 0, 0],
			],
		)
	})
})

describe('timing counterfactuals: utterances and early commit', () => {
	const events = log([
		[0, 'caller_turn_start', { transcript: 'I' }],
		[300, 'caller_update', { transcript: 'I need to', confidence: 0.3 }],
		[600, 'caller_update', { transcript: 'I need to reschedule', confidence: 0.5 }],
		[700, 'vad_speech_end'],
		[1_300, 'caller_turn_complete', { transcript: 'I need to reschedule.', confidence: 0.82 }],
		// Second utterance: the partial at VAD end was wrong.
		[3_000, 'caller_turn_start', { transcript: 'two' }],
		[3_200, 'caller_update', { transcript: 'two pm', confidence: 0.4 }],
		[3_300, 'vad_speech_end'],
		[3_450, 'caller_update', { transcript: 'two thirty pm', confidence: 0.6 }],
		[3_700, 'caller_turn_complete', { transcript: 'two thirty pm', confidence: 0.9 }],
	])

	it('groups partials with their final and measures VAD-end → final delay', () => {
		const groups = extractUtteranceGroups(events)
		assert.equal(groups.length, 2)
		assert.deepEqual(endpointingDelays(groups), [600, 400])
		assert.equal(groups[0]!.partials.length, 3)
		assert.equal(groups[0]!.final.confidence, 0.82)
	})

	it('normalizes punctuation and case for partial/final comparison', () => {
		assert.equal(normalizeTranscript('I need to reschedule.'), 'i need to reschedule')
		assert.equal(normalizeTranscript('  Two,  thirty PM '), 'two thirty pm')
	})

	it('sweeps guard windows: fires only when the guard beats Flux, and counts supersessions', () => {
		const groups = extractUtteranceGroups(events)
		const rows = sweepEarlyCommitGuards(groups, [100, 200, 500])
		// 100ms: both fire (700+100 < 1300; 3300+100 < 3700). First confirmed, second superseded ("two pm" vs "two thirty pm").
		assert.equal(rows[0]!.wouldFire, 2)
		assert.equal(rows[0]!.confirmed, 1)
		assert.equal(rows[0]!.superseded, 1)
		assert.equal(rows[0]!.supersededRate, 0.5)
		assert.equal(rows[0]!.meanSavedMs, 500)
		// 200ms: second utterance's latest partial at 3500 is "two thirty pm" → confirmed.
		assert.equal(rows[1]!.confirmed, 2)
		assert.equal(rows[1]!.superseded, 0)
		// 500ms: 700+500 = 1200 < 1300 fires; 3300+500 = 3800 ≥ 3700 does not.
		assert.equal(rows[2]!.wouldFire, 1)
	})
})

describe('timing counterfactuals: caller gaps and confidence', () => {
	it('measures playback end → caller start and histograms EOT confidence', () => {
		const events = log([
			[0, 'playback_confirmed'],
			[900, 'vad_speech_start'],
			[1_500, 'caller_turn_complete', { transcript: 'yes', confidence: 0.2 }],
			[2_000, 'playback_confirmed'],
			[2_000, 'playback_confirmed', {}, 'turnActor'],
			[4_400, 'vad_speech_start'],
			[5_000, 'caller_turn_complete', { transcript: 'ok', confidence: 0.5 }],
			[6_000, 'caller_turn_complete', { transcript: 'bye', confidence: 0.95 }],
		])
		assert.deepEqual(extractCallerGaps(events), [900, 2_400])
		assert.deepEqual(histogramEotConfidence(events, { low: 0.35, high: 0.7 }), {
			finals: 3,
			low: 1,
			middle: 1,
			high: 1,
		})
	})
})

describe('timing counterfactuals: overlap signatures', () => {
	it('counts resumes, drops while speaking, and hinted overlap turns the director answered with nothing', () => {
		const events = log([
			[0, 'first_audio_sent'],
			[1_000, 'caller_turn_start', { transcript: 'yeah' }],
			[1_300, 'backchannel_resumed', { transcript: 'yeah' }],
			// Still speaking: the acknowledgement's end-of-turn is dropped.
			[2_000, 'turn_outcome', { kind: 'discarded', turnId: 2, reason: 'backchannel_handled' }, undefined],
			[3_000, 'turn_outcome', { kind: 'committed', turnId: 1 }, undefined],
			// Next line: another acknowledgement, but the agent finished first.
			[3_100, 'first_audio_sent'],
			[4_000, 'caller_turn_start', { transcript: 'okay' }],
			[4_300, 'backchannel_resumed', { transcript: 'okay' }],
			[5_000, 'turn_outcome', { kind: 'committed', turnId: 3 }, undefined],
			[5_400, 'caller_turn_complete', { transcript: 'okay', confidence: 0.8 }],
			[5_900, 'turn_outcome', { kind: 'discarded', turnId: 4, reason: 'empty_response' }, undefined],
			// The caller then speaks again on their own: no answer was lost.
			[7_000, 'vad_speech_start'],
			[7_100, 'caller_turn_start', { transcript: 'so' }],
		])
		const sig = extractOverlapSignatures(events)
		assert.equal(sig.resumes, 2)
		assert.equal(sig.revoked, 0)
		assert.equal(sig.talkedOver, 0)
		assert.equal(sig.droppedAcknowledgments, 1)
		assert.deepEqual(sig.overlapTurns, { total: 1, answeredWithNothing: 1, answered: 0 })
		assert.equal(sig.lostAnswerCandidates, 0)
		assert.deepEqual(sig.samples.dropped, ['yeah'])
	})

	it('flags a lost-answer candidate when quiet on the caller is followed by a silence follow-up', () => {
		const events = log([
			[0, 'first_audio_sent'],
			[1_000, 'caller_turn_start', { transcript: 'yes' }],
			[1_300, 'backchannel_resumed', { transcript: 'yes' }],
			[2_000, 'turn_outcome', { kind: 'committed', turnId: 1 }, undefined],
			[2_400, 'caller_turn_complete', { transcript: 'yes', confidence: 0.9 }],
			[2_900, 'turn_outcome', { kind: 'discarded', turnId: 2, reason: 'empty_response' }, undefined],
			[8_900, 'silence_follow_up', { count: 1, closing: false }, undefined],
		])
		const sig = extractOverlapSignatures(events)
		assert.deepEqual(sig.overlapTurns, { total: 1, answeredWithNothing: 1, answered: 0 })
		assert.equal(sig.lostAnswerCandidates, 1)
		assert.deepEqual(sig.samples.lostAnswers, ['yes'])
	})

	it('separates revoked resumes from plain talk-overs', () => {
		const revoked = log([
			[0, 'first_audio_sent'],
			[1_000, 'caller_turn_start', { transcript: 'yeah' }],
			[1_300, 'backchannel_resumed', { transcript: 'yeah' }],
			[1_700, 'resume_revoked', { resumedOver: 'yeah', transcript: 'yeah but hang on' }, undefined],
			[1_750, 'turn_outcome', { kind: 'interrupted', turnId: 1, reason: 'caller_substantive_speech' }, undefined],
		])
		const talkedOver = log([
			[0, 'first_audio_sent'],
			[1_000, 'caller_turn_start', { transcript: 'right' }],
			[1_300, 'backchannel_resumed', { transcript: 'right' }],
			[2_200, 'turn_outcome', { kind: 'interrupted', turnId: 1, reason: 'caller_started_speaking' }, undefined],
		])
		const merged = mergeOverlapSignatures([extractOverlapSignatures(revoked), extractOverlapSignatures(talkedOver)])
		assert.equal(merged.resumes, 2)
		assert.equal(merged.revoked, 1)
		assert.equal(merged.talkedOver, 1)
		assert.deepEqual(merged.samples.revoked, ['yeah but hang on'])
	})
})
