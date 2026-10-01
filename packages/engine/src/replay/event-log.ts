/**
 * Per-call event log — the persistence substrate for branchable replay.
 *
 * Every timing-relevant thing that happens during a call is appended here
 * with a monotonic sequence number and a millisecond offset from call
 * start: caller/VAD events with transcripts, turn outcomes, per-turn
 * timings, tool lifecycle (proposed → gate → executed), speculation and
 * soft-pause outcomes, early-commit firings, physics latches.
 *
 * Unlike the 80-entry transcript window the tool watcher sees, this log is
 * uncapped — it exists so a production call can be replayed, judged, and
 * swept offline. Serialized as JSONL (one event per line) so logs stream
 * to S3 and diff cleanly.
 */

export interface CallEventRecord {
	/** Monotonic per-call sequence number, starting at 0. */
	seq: number
	/** Milliseconds since call start (recorder creation). */
	atMs: number
	type: string
	data: Record<string, unknown>
}

export interface CallEventRecorder {
	record: (type: string, data?: Record<string, unknown>) => void
	snapshot: () => CallEventRecord[]
	/** Milliseconds since the recorder was created. */
	elapsedMs: () => number
}

export function createCallEventRecorder(opts: { now?: () => number } = {}): CallEventRecorder {
	const now = opts.now ?? Date.now
	const startedAt = now()
	const events: CallEventRecord[] = []
	let seq = 0

	return {
		record(type, data = {}) {
			events.push({ seq: seq++, atMs: now() - startedAt, type, data })
		},
		snapshot() {
			return [...events]
		},
		elapsedMs() {
			return now() - startedAt
		},
	}
}

export function serializeEventLog(events: CallEventRecord[]): string {
	return events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : '')
}

export function parseEventLog(jsonl: string): CallEventRecord[] {
	const events: CallEventRecord[] = []
	for (const line of jsonl.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed) continue
		const parsed = JSON.parse(trimmed) as CallEventRecord
		if (typeof parsed.seq !== 'number' || typeof parsed.atMs !== 'number' || typeof parsed.type !== 'string') {
			throw new Error(`invalid event log line: ${trimmed.slice(0, 120)}`)
		}
		events.push({ seq: parsed.seq, atMs: parsed.atMs, type: parsed.type, data: parsed.data ?? {} })
	}
	return events
}

// ---------------------------------------------------------------------------
// Typed accessors used by counterfactual analysis and the replay harness.
// ---------------------------------------------------------------------------

/** Caller/VAD events that are *inputs* to the call machine — the replayable stimulus. */
export const replayableInputTypes = new Set([
	'vad_speech_start',
	'vad_speech_end',
	'caller_turn_start',
	'caller_update',
	'caller_eager_turn',
	'caller_turn_resumed',
	'caller_turn_complete',
	'transcriber_error',
	'start_first_turn',
])

export function eventTranscript(event: CallEventRecord): string {
	return typeof event.data.transcript === 'string' ? event.data.transcript : ''
}

export function eventConfidence(event: CallEventRecord): number {
	return typeof event.data.confidence === 'number' ? event.data.confidence : 0
}
