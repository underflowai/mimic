/**
 * Threshold sweep over a corpus of persisted call event logs.
 *
 * Replays timing counterfactuals against every log and aggregates:
 *   - substantive-speech threshold sweep (barge escalation vs hold)
 *   - early-commit guard sweep (latency saved vs wrong-transcript risk)
 *   - caller gap distribution (silence watchdog calibration)
 *
 * Sources (first match wins):
 *   --dir <path>   read *.jsonl files from a local directory
 *   (default)      download all call-events/*.jsonl from RECORDING_S3_BUCKET
 *
 * Usage:
 *   pnpm --filter @mimic/server exec tsx src/scripts/sweep-thresholds.ts
 *   pnpm --filter @mimic/server exec tsx src/scripts/sweep-thresholds.ts --dir ./logs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
	analyzeEarlyCommitGuards,
	analyzeSubstantiveSpeechThresholds,
	extractCallerGaps,
	parseEventLog,
	summarizeSeries,
	type CallEventRecord,
} from '@mimic/engine'

import { fetchCallEventLog, listCallEventLogs, eventLogStorageConfigured } from '../event-log-storage.js'

const SUBSTANTIVE_THRESHOLDS_MS = [200, 280, 350, 420, 500]
const EARLY_COMMIT_GUARDS_MS = [150, 200, 250, 300, 400]

interface CorpusEntry {
	name: string
	events: CallEventRecord[]
}

async function loadCorpus(): Promise<CorpusEntry[]> {
	const dirFlagIndex = process.argv.indexOf('--dir')
	if (dirFlagIndex !== -1) {
		const dir = process.argv[dirFlagIndex + 1]
		if (!dir) throw new Error('--dir requires a path')
		return readdirSync(dir)
			.filter((f) => f.endsWith('.jsonl'))
			.map((f) => ({ name: f, events: parseEventLog(readFileSync(join(dir, f), 'utf8')) }))
	}

	if (!eventLogStorageConfigured()) {
		throw new Error('RECORDING_S3_BUCKET not configured and no --dir given')
	}
	const keys = await listCallEventLogs()
	const entries: CorpusEntry[] = []
	for (const key of keys) {
		const jsonl = await fetchCallEventLog(key)
		if (jsonl) entries.push({ name: key, events: parseEventLog(jsonl) })
	}
	return entries
}

function pct(rate: number): string {
	return `${(rate * 100).toFixed(1)}%`
}

async function main() {
	const corpus = await loadCorpus()
	if (corpus.length === 0) {
		console.log('no event logs found')
		return
	}
	console.log(`corpus: ${corpus.length} calls\n`)

	// ── substantive speech sweep ─────────────────────────────────────
	const bargeAgg = new Map<number, { escalate: number; hold: number }>()
	for (const { events } of corpus) {
		for (const row of analyzeSubstantiveSpeechThresholds(events, SUBSTANTIVE_THRESHOLDS_MS)) {
			const agg = bargeAgg.get(row.thresholdMs) ?? { escalate: 0, hold: 0 }
			agg.escalate += row.wouldEscalate
			agg.hold += row.wouldHold
			bargeAgg.set(row.thresholdMs, agg)
		}
	}
	console.log('substantive-speech threshold (barge → escalate vs hold):')
	console.log('  threshold   escalate   hold   escalate%')
	for (const t of SUBSTANTIVE_THRESHOLDS_MS) {
		const agg = bargeAgg.get(t) ?? { escalate: 0, hold: 0 }
		const total = agg.escalate + agg.hold
		const rate = total > 0 ? agg.escalate / total : 0
		console.log(
			`  ${String(t).padStart(6)}ms   ${String(agg.escalate).padStart(8)}   ${String(agg.hold).padStart(4)}   ${pct(rate).padStart(9)}`,
		)
	}

	// ── early-commit guard sweep ─────────────────────────────────────
	const commitAgg = new Map<number, { fires: number; confirmed: number; superseded: number; savedMs: number[] }>()
	for (const { events } of corpus) {
		for (const row of analyzeEarlyCommitGuards(events, EARLY_COMMIT_GUARDS_MS)) {
			const agg = commitAgg.get(row.guardMs) ?? { fires: 0, confirmed: 0, superseded: 0, savedMs: [] }
			agg.fires += row.wouldFire
			agg.confirmed += row.confirmed
			agg.superseded += row.superseded
			if (row.confirmed > 0) agg.savedMs.push(row.meanSavedMs)
			commitAgg.set(row.guardMs, agg)
		}
	}
	console.log('\nearly-commit guard (fire rate vs wrong-transcript risk):')
	console.log('  guard   fires   confirmed   superseded   superseded%   ~saved')
	for (const g of EARLY_COMMIT_GUARDS_MS) {
		const agg = commitAgg.get(g) ?? { fires: 0, confirmed: 0, superseded: 0, savedMs: [] }
		const rate = agg.fires > 0 ? agg.superseded / agg.fires : 0
		const saved =
			agg.savedMs.length > 0
				? `${Math.round(agg.savedMs.reduce((a, b) => a + b, 0) / agg.savedMs.length)}ms`
				: '—'
		console.log(
			`  ${String(g).padStart(3)}ms   ${String(agg.fires).padStart(5)}   ${String(agg.confirmed).padStart(9)}   ${String(agg.superseded).padStart(10)}   ${pct(rate).padStart(11)}   ${saved.padStart(6)}`,
		)
	}

	// ── caller gap distribution ──────────────────────────────────────
	const allGaps: number[] = []
	for (const { events } of corpus) {
		allGaps.push(...extractCallerGaps(events))
	}
	const summary = summarizeSeries(allGaps)
	console.log('\ncaller response gaps (agent playback end → caller speech):')
	console.log(
		`  n=${summary.count}  p50=${summary.p50}ms  p95=${summary.p95}ms  max=${summary.max}ms`,
	)
	console.log('  (silence watchdog delays should sit above p95 for non-question turns)')
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
