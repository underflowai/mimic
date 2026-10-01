/**
 * Call Metrics
 *
 * Instruments timing-sensitive paths in the voice pipeline to guide
 * optimization decisions. Collected per-call and returned from close().
 *
 * Every recording method also emits a Sentry metric (counter, distribution,
 * or gauge) so values are tracked over time. Per-call summary metrics are
 * emitted via publishCallSummary() at shutdown.
 */

import * as telemetry from '#engine/telemetry.js'

/**
 * How caller speech during an agent turn resolved.
 *   interrupted         the caller took the floor
 *   short_resumed       VAD ended before we had to decide
 *   backchannel_resumed the transcriber heard only listening noises (or a reply to our question)
 *   timeout             VAD stayed active but no words ever arrived; treated as noise
 */
export type BargeOutcome = 'interrupted' | 'short_resumed' | 'backchannel_resumed' | 'timeout'

export interface BargeEvent {
	outcome: BargeOutcome
	wordCount: number
	elapsedMs: number
}

export interface TurnTiming {
	turnId: number
	kind: 'fresh' | 'presynthesized' | 'first_turn'
	generationToAudioCompleteMs: number
	generationToFirstAudioMs: number | null
	turnCompleteToFirstAudioMs: number | null
	vadEndToTurnCompleteMs: number | null
	vadEndToFirstAudioMs: number | null
	ttsFirstByteMs: number | null
	llmFirstTokenMs: number | null
	llmCompleteMs: number | null
}

export type SpeculationOutcome =
	| 'eager_regenerated'
	| 'validated_eager'
	| 'validation_failed_eager'
	| 'fresh_fallback'
	| 'promoted'
	| 'discarded_diverged'
	| 'discarded_resumed'
	| 'discarded_timeout'

export interface SpeculationEvent {
	outcome: SpeculationOutcome
	speculativeTranscript: string
	finalTranscript: string
	speculationDurationMs: number
}

/**
 * Where a soft-pause originated.
 *
 * Enumerated so dashboards can filter cardinality cleanly.
 */
export type SoftPauseSource = 'deepgram_turn_start' | 'yield_timer' | 'unknown'

/**
 * How a soft-pause terminated. Every machine exit from `softPaused` MUST
 * record one of these outcomes so funnels add up.
 */
export type SoftPauseOutcome =
	| 'resumed' // VAD speech end: caller stopped talking, agent resumes
	| 'escalated_to_interrupt' // substantive speech timeout: caller kept talking
	| 'deferred' // handleTurnComplete while in softPaused
	| 'interrupted' // external interrupt (call_ended, caller_substantive_speech)
	| 'reset' // reset_idle

export interface SoftPauseEvent {
	source: SoftPauseSource
	outcome: SoftPauseOutcome
	durationMs: number
}

export type TurnOutcomeMetric = 'committed' | 'interrupted' | 'discarded' | 'deferred'

export interface CallMetrics {
	readonly turnTimings: readonly TurnTiming[]
	readonly bargeEvents: readonly BargeEvent[]
	readonly speculationEvents: readonly SpeculationEvent[]
	readonly softPauseEvents: readonly SoftPauseEvent[]
	readonly turnOutcomes: readonly TurnOutcomeMetric[]
	readonly discardedTurns: number
	/** Fresh turns where the model was slow enough that a filler was spoken first. */
	readonly latencyFillers: number
}

export interface SeriesSummary {
	avg: number
	p50: number
	p95: number
	min: number
	max: number
}

/** The per-turn latency fields; each becomes a Sentry distribution and a summary series. */
type TurnTimingField = Exclude<keyof TurnTiming, 'turnId' | 'kind'>

const turnTimingMetrics: Record<TurnTimingField, string> = {
	generationToAudioCompleteMs: 'mimic.turn.generation_to_audio_complete_ms',
	generationToFirstAudioMs: 'mimic.turn.generation_to_first_audio_ms',
	turnCompleteToFirstAudioMs: 'mimic.turn.turn_complete_to_first_audio_ms',
	vadEndToTurnCompleteMs: 'mimic.turn.vad_end_to_turn_complete_ms',
	vadEndToFirstAudioMs: 'mimic.turn.vad_end_to_first_audio_ms',
	ttsFirstByteMs: 'mimic.turn.tts_first_byte_ms',
	llmFirstTokenMs: 'mimic.turn.llm_first_token_ms',
	llmCompleteMs: 'mimic.turn.llm_complete_ms',
}

const turnTimingFields = Object.keys(turnTimingMetrics) as TurnTimingField[]

export type CallLatencySummary = Record<TurnTimingField, SeriesSummary> & {
	turns: number
	barges: number
	softPauses: number
	discarded: number
	latencyFillers: number
}

/** Values of one timing field across turns, skipping turns where it was not measured. */
function timingSeries(turnTimings: readonly TurnTiming[], field: TurnTimingField): number[] {
	return turnTimings.map((t) => t[field]).filter((v): v is number => v !== null)
}

function average(values: readonly number[]) {
	return Math.round(values.reduce((a, b) => a + b, 0) / values.length)
}

function percentile(sorted: readonly number[], fraction: number) {
	return sorted[Math.min(Math.ceil(sorted.length * fraction) - 1, sorted.length - 1)]
}

export function summarizeSeries(values: readonly number[]): SeriesSummary {
	if (values.length === 0) return { avg: 0, p50: 0, p95: 0, min: 0, max: 0 }
	const sorted = [...values].sort((a, b) => a - b)
	return {
		avg: average(values),
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		min: sorted[0],
		max: sorted[sorted.length - 1],
	}
}

export function createCallMetrics() {
	const turnTimings: TurnTiming[] = []
	const bargeEvents: BargeEvent[] = []
	const speculationEvents: SpeculationEvent[] = []
	const softPauseEvents: SoftPauseEvent[] = []
	const turnOutcomes: TurnOutcomeMetric[] = []
	let discardedTurns = 0
	let latencyFillers = 0

	return {
		get turnTimings(): readonly TurnTiming[] {
			return turnTimings
		},
		get bargeEvents(): readonly BargeEvent[] {
			return bargeEvents
		},
		get speculationEvents(): readonly SpeculationEvent[] {
			return speculationEvents
		},
		get softPauseEvents(): readonly SoftPauseEvent[] {
			return softPauseEvents
		},
		get turnOutcomes(): readonly TurnOutcomeMetric[] {
			return turnOutcomes
		},
		get discardedTurns() {
			return discardedTurns
		},

		recordTurnTiming(timing: TurnTiming) {
			turnTimings.push(timing)
			for (const field of turnTimingFields) {
				const value = timing[field]
				if (value !== null) telemetry.metrics.distribution(turnTimingMetrics[field], value, { unit: 'millisecond' })
			}
			telemetry.metrics.count('mimic.turn.generation_strategy', 1, { attributes: { strategy: timing.kind } })
		},

		recordBarge(event: BargeEvent) {
			bargeEvents.push(event)
			telemetry.metrics.count('mimic.barge', 1, { attributes: { outcome: event.outcome } })
			if (event.outcome === 'interrupted') {
				telemetry.metrics.distribution('mimic.barge.elapsed_ms', event.elapsedMs, { unit: 'millisecond' })
			}
		},

		recordSpeculation(event: SpeculationEvent) {
			speculationEvents.push(event)
			telemetry.metrics.count('mimic.speculation', 1, { attributes: { outcome: event.outcome } })
			telemetry.metrics.distribution('mimic.speculation.duration_ms', event.speculationDurationMs, {
				unit: 'millisecond',
				attributes: { outcome: event.outcome },
			})
		},

		recordSoftPause(event: SoftPauseEvent) {
			softPauseEvents.push(event)
			telemetry.metrics.count('mimic.soft_pause', 1, {
				attributes: { source: event.source, outcome: event.outcome },
			})
			telemetry.metrics.distribution('mimic.soft_pause.duration_ms', event.durationMs, {
				unit: 'millisecond',
				attributes: { outcome: event.outcome },
			})
		},

		recordTurnOutcome(outcome: TurnOutcomeMetric) {
			turnOutcomes.push(outcome)
			telemetry.metrics.count('mimic.turn.outcome', 1, { attributes: { outcome } })
		},

		incrementDiscarded() {
			discardedTurns++
			telemetry.metrics.count('mimic.turn.discarded')
		},

		recordLatencyFiller() {
			latencyFillers++
			telemetry.metrics.count('mimic.turn.latency_filler')
		},

		snapshot(): CallMetrics {
			return {
				turnTimings: [...turnTimings],
				bargeEvents: [...bargeEvents],
				speculationEvents: [...speculationEvents],
				softPauseEvents: [...softPauseEvents],
				turnOutcomes: [...turnOutcomes],
				discardedTurns,
				latencyFillers,
			}
		},

		summarize(): CallLatencySummary {
			const series = Object.fromEntries(
				turnTimingFields.map((field) => [field, summarizeSeries(timingSeries(turnTimings, field))]),
			) as Record<TurnTimingField, SeriesSummary>
			return {
				...series,
				turns: turnTimings.length,
				barges: bargeEvents.length,
				softPauses: softPauseEvents.length,
				discarded: discardedTurns,
				latencyFillers,
			}
		},
	}
}

export type Metrics = ReturnType<typeof createCallMetrics>

export function publishCallSummary(snapshot: CallMetrics, durationSeconds: number) {
	telemetry.metrics.count('mimic.call.completed')
	telemetry.metrics.distribution('mimic.call.duration_seconds', durationSeconds, { unit: 'second' })
	telemetry.metrics.gauge('mimic.call.turns', snapshot.turnTimings.length)

	if (snapshot.bargeEvents.length > 0) {
		telemetry.metrics.gauge('mimic.call.barges', snapshot.bargeEvents.length)
	}

	if (snapshot.discardedTurns > 0) {
		telemetry.metrics.gauge('mimic.call.discarded_turns', snapshot.discardedTurns)
	}

	const reused = snapshot.speculationEvents.filter(
		(e) => e.outcome === 'validated_eager' || e.outcome === 'promoted',
	).length
	const total = snapshot.speculationEvents.filter(
		(e) => e.outcome === 'validated_eager' || e.outcome === 'validation_failed_eager' || e.outcome === 'promoted',
	).length
	if (total > 0) {
		telemetry.metrics.gauge('mimic.call.speculation_hit_rate', reused / total)
	}
	const eagerReused = snapshot.speculationEvents.filter((e) => e.outcome === 'validated_eager').length
	const eagerRegenerated = snapshot.speculationEvents.filter((e) => e.outcome === 'eager_regenerated').length
	if (eagerReused > 0) telemetry.metrics.gauge('mimic.call.speculation_eager_reused', eagerReused)
	if (eagerRegenerated > 0) telemetry.metrics.gauge('mimic.call.speculation_eager_regenerated', eagerRegenerated)

	if (snapshot.softPauseEvents.length > 0) {
		telemetry.metrics.gauge('mimic.call.soft_pauses', snapshot.softPauseEvents.length)
		const escalated = snapshot.softPauseEvents.filter((e) => e.outcome === 'escalated_to_interrupt').length
		telemetry.metrics.gauge('mimic.call.soft_pause_escalation_rate', escalated / snapshot.softPauseEvents.length)
	}

	const perCallAverages: Array<[TurnTimingField, string]> = [
		['turnCompleteToFirstAudioMs', 'mimic.call.turn_complete_to_first_audio_avg_ms'],
		['vadEndToTurnCompleteMs', 'mimic.call.vad_end_to_turn_complete_avg_ms'],
		['vadEndToFirstAudioMs', 'mimic.call.vad_end_to_first_audio_avg_ms'],
	]
	for (const [field, metric] of perCallAverages) {
		const values = timingSeries(snapshot.turnTimings, field)
		if (values.length > 0) telemetry.metrics.distribution(metric, average(values), { unit: 'millisecond' })
	}
}
