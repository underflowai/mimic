/**
 * Per-call event log.
 *
 * Every event the call machine and its children receive (caller/VAD events
 * with transcripts and confidences, pipeline progress, soft-pause decisions,
 * timer firings, tool lifecycle) is appended with a monotonic sequence number
 * and a millisecond offset on the engine clock, plus the things the machines
 * only emit (turn outcomes) and a metrics summary at close.
 *
 * The tap is XState's `inspect` hook, so nothing in the machines knows the
 * log exists. Payloads are sanitized to JSON primitives (strings truncated,
 * buffers and handles dropped) so a log line is always small and safe to
 * ship. Serialized as JSONL: one event per line, appended to S3 beside the
 * recording, so thresholds can be swept offline against real calls instead
 * of guessed (see `timing-counterfactuals.ts`).
 */

import type { AnyEventObject, InspectionEvent } from 'xstate'

import { monotonicClock, type Clock } from '../shared/clock.js'

export interface CallEventRecord {
	/** Monotonic per-call sequence number, starting at 0. */
	seq: number
	/** Milliseconds since the recorder was created, on the engine clock. */
	atMs: number
	type: string
	/** Receiving actor id for machine events (`call`, `turnActor`, …); absent for recorder-side records. */
	actor?: string
	data: Record<string, unknown>
}

export interface CallEventRecorder {
	record: (type: string, data?: Record<string, unknown>) => void
	/** Pass as `createActor(machine, { inspect })`. */
	inspect: (event: InspectionEvent) => void
	snapshot: () => CallEventRecord[]
	size: () => number
}

export interface CallEventRecorderOptions {
	clock?: Clock
	/** Hard cap so an hour-long call cannot grow memory without bound. */
	maxEvents?: number
}

/** The root call machine's id; caller and VAD events are recorded against it. */
export const callMachineActorId = 'call'

const maxStringLength = 1_000
const maxArrayLength = 20

/** Keep primitives, one level of plain nested objects, and short primitive arrays. Drop the rest. */
export function sanitizeEventData(event: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(event)) {
		if (key === 'type') continue
		const kept = sanitizeValue(value, 0)
		if (kept !== undefined) out[key] = kept
	}
	return out
}

function sanitizeValue(value: unknown, depth: number): unknown {
	if (value === null) return null
	switch (typeof value) {
		case 'string':
			return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}…` : value
		case 'number':
			return Number.isFinite(value) ? value : String(value)
		case 'boolean':
			return value
		case 'object':
			break
		default:
			return undefined
	}
	if (Array.isArray(value)) {
		if (depth > 0) return undefined
		const items = value.slice(0, maxArrayLength).map((item) => sanitizeValue(item, depth + 1))
		return items.every((item) => item !== undefined && (item === null || typeof item !== 'object')) ? items : undefined
	}
	if (depth > 0) return undefined
	const proto = Object.getPrototypeOf(value)
	if (proto !== Object.prototype && proto !== null) return undefined
	const nested: Record<string, unknown> = {}
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		const kept = sanitizeValue(item, depth + 1)
		if (kept !== undefined && (kept === null || typeof kept !== 'object')) nested[key] = kept
	}
	return nested
}

/**
 * Children carry the ids they were invoked/spawned with (`turnActor`,
 * `eager-pipeline`, …). The root actor's id is its session id (`x:0`), so
 * it is labelled with the machine's id instead.
 */
function actorIdOf(inspection: InspectionEvent): string | undefined {
	const ref = inspection.actorRef as { id?: unknown; sessionId?: unknown } | undefined
	if (!ref || typeof ref !== 'object') return undefined
	if (typeof ref.sessionId === 'string' && ref.sessionId === inspection.rootId) return callMachineActorId
	if (typeof ref.id === 'string') return ref.id
	if (typeof ref.sessionId === 'string') return ref.sessionId
	return undefined
}

export function createCallEventRecorder(options: CallEventRecorderOptions = {}): CallEventRecorder {
	const clock = options.clock ?? monotonicClock
	const maxEvents = options.maxEvents ?? 50_000
	const startedAt = clock.now()
	const events: CallEventRecord[] = []
	let seq = 0
	let truncated = false

	function push(type: string, data: Record<string, unknown>, actor?: string) {
		if (events.length >= maxEvents) {
			if (!truncated) {
				truncated = true
				events.push({
					seq: seq++,
					atMs: Math.round(clock.now() - startedAt),
					type: 'event_log_truncated',
					data: { maxEvents },
				})
			}
			return
		}
		const record: CallEventRecord = { seq: seq++, atMs: Math.round(clock.now() - startedAt), type, data }
		if (actor) record.actor = actor
		events.push(record)
	}

	return {
		record(type, data = {}) {
			push(type, sanitizeEventData(data))
		},
		inspect(inspection) {
			if (inspection.type !== '@xstate.event') return
			const event = inspection.event as AnyEventObject
			if (typeof event.type !== 'string' || event.type === 'xstate.init') return
			push(event.type, sanitizeEventData(event), actorIdOf(inspection))
		},
		snapshot() {
			return [...events]
		},
		size() {
			return events.length
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
		const parsed = JSON.parse(trimmed) as Partial<CallEventRecord>
		if (typeof parsed.seq !== 'number' || typeof parsed.atMs !== 'number' || typeof parsed.type !== 'string') {
			throw new Error(`invalid event log line: ${trimmed.slice(0, 120)}`)
		}
		const record: CallEventRecord = { seq: parsed.seq, atMs: parsed.atMs, type: parsed.type, data: parsed.data ?? {} }
		if (typeof parsed.actor === 'string') record.actor = parsed.actor
		events.push(record)
	}
	return events
}

export function eventTranscript(event: CallEventRecord): string {
	return typeof event.data.transcript === 'string' ? event.data.transcript : ''
}

export function eventConfidence(event: CallEventRecord): number | null {
	return typeof event.data.confidence === 'number' ? event.data.confidence : null
}
