import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { CallEventRecord } from './event-log.js'
import {
	analyzeEarlyCommitGuards,
	analyzeSubstantiveSpeechThresholds,
	extractBargeEpisodes,
	extractUtteranceGroups,
	summarizeCallerGaps,
} from './timing-counterfactuals.js'

let seq = 0
function ev(atMs: number, type: string, data: Record<string, unknown> = {}): CallEventRecord {
	return { seq: seq++, atMs, type, data }
}

describe('barge episodes / substantive-speech sweep', () => {
	it('extracts caller speech that overlaps agent audio', () => {
		const events = [
			ev(0, 'agent_first_audio', { turnId: 1 }),
			ev(500, 'vad_speech_start'),
			ev(800, 'vad_speech_end'), // 300ms interjection during agent speech
			ev(2_000, 'agent_playback_complete', { turnId: 1 }),
			ev(3_000, 'vad_speech_start'), // normal turn, agent not speaking
			ev(4_000, 'vad_speech_end'),
			ev(5_000, 'agent_first_audio', { turnId: 2 }),
			ev(5_200, 'vad_speech_start'),
			ev(6_400, 'vad_speech_end'), // 1200ms sustained barge
		]

		const episodes = extractBargeEpisodes(events)
		assert.equal(episodes.length, 2)
		assert.equal(episodes[0].speechDurationMs, 300)
		assert.equal(episodes[0].turnId, 1)
		assert.equal(episodes[1].speechDurationMs, 1200)
	})

	it('sweeps thresholds over the episodes', () => {
		const events = [
			ev(0, 'agent_first_audio', { turnId: 1 }),
			ev(100, 'vad_speech_start'),
			ev(400, 'vad_speech_end'), // 300ms
			ev(1_000, 'vad_speech_start'),
			ev(1_900, 'vad_speech_end'), // 900ms
		]

		const rows = analyzeSubstantiveSpeechThresholds(events, [500, 1_000])
		assert.deepEqual(
			rows.map((r) => ({ t: r.thresholdMs, hold: r.wouldHold, esc: r.wouldEscalate })),
			[
				{ t: 500, hold: 1, esc: 1 },
				{ t: 1_000, hold: 2, esc: 0 },
			],
		)
		assert.equal(rows[0].escalationRate, 0.5)
	})

	it('treats interrupted turn outcomes as ending agent audio', () => {
		const events = [
			ev(0, 'agent_first_audio', { turnId: 1 }),
			ev(300, 'turn_outcome', { kind: 'interrupted', turnId: 1 }),
			ev(500, 'vad_speech_start'), // after the interrupt — not a barge
			ev(900, 'vad_speech_end'),
		]
		assert.equal(extractBargeEpisodes(events).length, 0)
	})
})

describe('early-commit guard sweep', () => {
	it('groups utterances and evaluates partial-vs-final matches per guard', () => {
		const events = [
			ev(0, 'caller_turn_start', { transcript: 'i' }),
			ev(200, 'caller_update', { transcript: 'i need to' }),
			ev(600, 'caller_update', { transcript: 'i need to reschedule' }),
			ev(700, 'vad_speech_end'),
			// Flux EOT lands 500ms after VAD end with the same content.
			ev(1_200, 'caller_turn_complete', { transcript: 'I need to reschedule.', confidence: 0.9 }),
		]

		const groups = extractUtteranceGroups(events)
		assert.equal(groups.length, 1)
		assert.equal(groups[0].vadEndAtMs, 700)

		const rows = analyzeEarlyCommitGuards(events, [100, 600])
		// Guard 100: fires at 800 with matching partial, saves 400ms.
		assert.equal(rows[0].wouldFire, 1)
		assert.equal(rows[0].confirmed, 1)
		assert.equal(rows[0].meanSavedMs, 400)
		// Guard 600: would fire at 1300, after Flux already finalized — no gain.
		assert.equal(rows[1].wouldFire, 0)
	})

	it('counts superseded commits when the partial differs from the final', () => {
		const events = [
			ev(0, 'caller_turn_start', { transcript: 'tuesday' }),
			ev(300, 'vad_speech_end'),
			ev(900, 'caller_turn_complete', { transcript: 'tuesday no wait thursday', confidence: 0.9 }),
		]
		const rows = analyzeEarlyCommitGuards(events, [200])
		assert.equal(rows[0].wouldFire, 1)
		assert.equal(rows[0].superseded, 1)
		assert.equal(rows[0].supersededRate, 1)
	})

	it('skips early-commit synthetic finals', () => {
		const events = [
			ev(0, 'caller_turn_start', { transcript: 'yes' }),
			ev(200, 'vad_speech_end'),
			ev(440, 'early_commit_fired', { transcript: 'yes' }),
			ev(441, 'caller_turn_complete', { transcript: 'yes', confidence: 0.85 }), // synthetic
			ev(900, 'caller_turn_complete', { transcript: 'yes', confidence: 0.95 }), // real Flux final
		]
		const groups = extractUtteranceGroups(events)
		assert.equal(groups.length, 1)
		assert.equal(groups[0].final.atMs, 900)
	})
})

describe('caller gap distribution', () => {
	it('measures playback-complete to next speech start', () => {
		const events = [
			ev(1_000, 'agent_playback_complete', { turnId: 1 }),
			ev(1_600, 'vad_speech_start'),
			ev(3_000, 'agent_playback_complete', { turnId: 2 }),
			ev(4_200, 'vad_speech_start'),
		]
		const summary = summarizeCallerGaps(events)
		assert.equal(summary.count, 2)
		assert.equal(summary.min, 600)
		assert.equal(summary.max, 1200)
		assert.equal(summary.mean, 900)
	})
})
