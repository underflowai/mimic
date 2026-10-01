/**
 * Sweep turn-taking thresholds against recorded call event logs.
 *
 * Reads per-call JSONL event logs (from S3 under `call-events/`, or a local
 * directory of `.jsonl` files), pools the episodes, and prints what each
 * threshold would have done to real calls:
 *
 *   - soft pauses: VAD-only hiccup durations (→ MIMIC_VAD_ONLY_GRACE_MS) and
 *     how long words take to arrive after VAD start (→ MIMIC_SUBSTANTIVE_SPEECH_MS),
 *     with the backchannel / answer / speech breakdown and what the engine did
 *   - endpointing: VAD end → Flux final delay, and the early-commit guard
 *     sweep (how often a partial at +Nms matched the final)
 *   - caller response gaps after agent playback (→ silenceIdleMs)
 *   - end-of-turn confidence histogram (→ MIMIC_LOW_CONFIDENCE_EOT / MIMIC_FLUX_EOT_THRESHOLD)
 *
 * Usage:
 *   tsx src/scripts/sweep-thresholds.ts --s3 [limit]        # RECORDING_S3_* env
 *   tsx src/scripts/sweep-thresholds.ts --dir <path>
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
	config,
	endpointingDelays,
	extractBargeEpisodes,
	extractCallerGaps,
	extractUtteranceGroups,
	histogramEotConfidence,
	parseEventLog,
	summarizeEventSeries,
	summarizeSoftPauses,
	sweepEarlyCommitGuards,
	sweepProbeWindows,
	type BargeEpisode,
	type CallEventRecord,
	type UtteranceGroup,
} from '@mimic/engine'

import { createEventLogStorage } from '../event-log-storage.js'

const args = process.argv.slice(2)

async function loadLogs(): Promise<Array<{ name: string; events: CallEventRecord[] }>> {
	if (args[0] === '--dir' && args[1]) {
		const dir = args[1]
		const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort()
		return Promise.all(
			files.map(async (file) => ({ name: file, events: parseEventLog(await readFile(join(dir, file), 'utf8')) })),
		)
	}
	if (args[0] === '--s3') {
		const storage = createEventLogStorage()
		if (!storage) {
			console.error('RECORDING_S3_BUCKET is not set.')
			process.exit(1)
		}
		const limit = Number(args[1] ?? 200)
		const keys = await storage.list(limit)
		const logs: Array<{ name: string; events: CallEventRecord[] }> = []
		for (const key of keys) {
			try {
				logs.push({ name: key, events: await storage.fetch(key) })
			} catch (err) {
				console.error(`skipping ${key}: ${err instanceof Error ? err.message : String(err)}`)
			}
		}
		return logs
	}
	console.error('Usage: tsx src/scripts/sweep-thresholds.ts --s3 [limit] | --dir <path>')
	process.exit(1)
}

function pct(n: number, d: number): string {
	return d === 0 ? '-' : `${Math.round((n / d) * 100)}%`
}

const logs = await loadLogs()
if (logs.length === 0) {
	console.error('No event logs found.')
	process.exit(1)
}

const episodes: BargeEpisode[] = []
const groups: UtteranceGroup[] = []
const gaps: number[] = []
let finals = 0
let low = 0
let middle = 0
let high = 0
const floors = { low: config.mimic.flux.lowConfidenceEot, high: config.mimic.flux.eotThreshold }

for (const { events } of logs) {
	episodes.push(...extractBargeEpisodes(events))
	groups.push(...extractUtteranceGroups(events))
	gaps.push(...extractCallerGaps(events))
	const histogram = histogramEotConfidence(events, floors)
	finals += histogram.finals
	low += histogram.low
	middle += histogram.middle
	high += histogram.high
}

console.log(`\n${logs.length} call logs, ${episodes.length} soft-pause episodes, ${groups.length} utterances\n`)

console.log('== Soft pauses (caller speech while the agent talks) ==')
const soft = summarizeSoftPauses(episodes)
console.table(
	Object.entries(soft.byKind).map(([kind, row]) => ({
		kind,
		episodes: row.count,
		interrupted: row.interrupted,
		'interrupted %': pct(row.interrupted, row.count),
	})),
)
console.log('VAD-only hiccup durations (ms) → MIMIC_VAD_ONLY_GRACE_MS:', soft.vadOnlyDurationsMs)
console.log('VAD start → first words (ms)   → MIMIC_SUBSTANTIVE_SPEECH_MS:', soft.firstWordsAfterMs)
console.log(
	`current: substantiveSpeechMs=${config.mimic.turnTaking.substantiveSpeechMs} vadOnlyGraceMs=${config.mimic.turnTaking.vadOnlyGraceMs}`,
)
console.table(
	sweepProbeWindows(episodes, [150, 200, 250, 300, 350, 400, 500, 600, 800]).map((row) => ({
		'probe ms': row.probeMs,
		'decided on words': `${row.decidedOnWords}/${row.wordedEpisodes} (${pct(row.decidedOnWords, row.wordedEpisodes)})`,
		'words too late': row.wordsTooLate,
		'hiccups outlasting probe': `${row.vadOnlyStillActive}/${row.vadOnlyEpisodes}`,
	})),
)

console.log('\n== Endpointing (VAD end → Flux final) ==')
console.log('delay (ms):', summarizeEventSeries(endpointingDelays(groups)))
console.table(
	sweepEarlyCommitGuards(groups, [100, 150, 200, 250, 300, 400, 500, 700]).map((row) => ({
		'guard ms': row.guardMs,
		'would fire': `${row.wouldFire}/${row.utterances}`,
		confirmed: row.confirmed,
		superseded: row.superseded,
		'superseded %': pct(row.superseded, row.wouldFire),
		'mean saved ms': row.meanSavedMs,
	})),
)

console.log('\n== Caller response gap after agent playback (ms) → silenceIdleMs ==')
console.log(summarizeEventSeries(gaps), `current: ${config.mimic.turnTaking.silenceIdleMs}`)

console.log('\n== End-of-turn confidence ==')
console.table([
	{ band: `< ${floors.low} (trailing off)`, finals: low, share: pct(low, finals) },
	{ band: `${floors.low} – ${floors.high} (timeout-forced)`, finals: middle, share: pct(middle, finals) },
	{ band: `≥ ${floors.high} (confident)`, finals: high, share: pct(high, finals) },
])
