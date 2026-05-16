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

export type BargeOutcome = 'interrupted' | 'short_resumed' | 'timeout'

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
}

export interface CallLatencySummary {
	turns: number
	generationToAudioCompleteMs: { avg: number; p50: number; p95: number; min: number; max: number }
	generationToFirstAudioMs: { avg: number; p50: number; p95: number; min: number; max: number }
	turnCompleteToFirstAudioMs: { avg: number; p50: number; p95: number; min: number; max: number }
	vadEndToTurnCompleteMs: { avg: number; p50: number; p95: number; min: number; max: number }
	vadEndToFirstAudioMs: { avg: number; p50: number; p95: number; min: number; max: number }
	ttsFirstByteMs: { avg: number; p50: number; p95: number; min: number; max: number }
	llmFirstTokenMs: { avg: number; p50: number; p95: number; min: number; max: number }
	llmCompleteMs: { avg: number; p50: number; p95: number; min: number; max: number }
	barges: number
	softPauses: number
	discarded: number
}

function summarizeSeries(values: number[]) {
	if (values.length === 0) return { avg: 0, p50: 0, p95: 0, min: 0, max: 0 }
	const sorted = [...values].sort((a, b) => a - b)
	const p50Index = Math.min(Math.ceil(sorted.length * 0.5) - 1, sorted.length - 1)
	const p95Index = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1)
	return {
		avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
		p50: sorted[p50Index],
		p95: sorted[p95Index],
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
			telemetry.metrics.distribution('mimic.turn.generation_to_audio_complete_ms', timing.generationToAudioCompleteMs, {
				unit: 'millisecond',
			})
			if (timing.generationToFirstAudioMs !== null) {
				telemetry.metrics.distribution('mimic.turn.generation_to_first_audio_ms', timing.generationToFirstAudioMs, {
					unit: 'millisecond',
				})
			}
			if (timing.turnCompleteToFirstAudioMs !== null) {
				telemetry.metrics.distribution(
					'mimic.turn.turn_complete_to_first_audio_ms',
					timing.turnCompleteToFirstAudioMs,
					{ unit: 'millisecond' },
				)
			}
			if (timing.vadEndToTurnCompleteMs !== null) {
				telemetry.metrics.distribution('mimic.turn.vad_end_to_turn_complete_ms', timing.vadEndToTurnCompleteMs, {
					unit: 'millisecond',
				})
			}
			if (timing.vadEndToFirstAudioMs !== null) {
				telemetry.metrics.distribution('mimic.turn.vad_end_to_first_audio_ms', timing.vadEndToFirstAudioMs, {
					unit: 'millisecond',
				})
			}
			if (timing.ttsFirstByteMs !== null) {
				telemetry.metrics.distribution('mimic.turn.tts_first_byte_ms', timing.ttsFirstByteMs, {
					unit: 'millisecond',
				})
			}
			if (timing.llmFirstTokenMs !== null) {
				telemetry.metrics.distribution('mimic.turn.llm_first_token_ms', timing.llmFirstTokenMs, {
					unit: 'millisecond',
				})
			}
			if (timing.llmCompleteMs !== null) {
				telemetry.metrics.distribution('mimic.turn.llm_complete_ms', timing.llmCompleteMs, {
					unit: 'millisecond',
				})
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

		snapshot(): CallMetrics {
			return {
				turnTimings: [...turnTimings],
				bargeEvents: [...bargeEvents],
				speculationEvents: [...speculationEvents],
				softPauseEvents: [...softPauseEvents],
				turnOutcomes: [...turnOutcomes],
				discardedTurns,
			}
		},

		summarize(): CallLatencySummary {
			const generationToComplete = turnTimings.map((t) => t.generationToAudioCompleteMs)
			const generationToFirstAudio = turnTimings
				.filter((t) => t.generationToFirstAudioMs !== null)
				.map((t) => t.generationToFirstAudioMs!)
			const turnCompleteToFirstAudio = turnTimings
				.filter((t) => t.turnCompleteToFirstAudioMs !== null)
				.map((t) => t.turnCompleteToFirstAudioMs!)
			const vadToTurnComplete = turnTimings
				.filter((t) => t.vadEndToTurnCompleteMs !== null)
				.map((t) => t.vadEndToTurnCompleteMs!)
			const vadToFirstAudio = turnTimings
				.filter((t) => t.vadEndToFirstAudioMs !== null)
				.map((t) => t.vadEndToFirstAudioMs!)
			const ttsFirstBytes = turnTimings.filter((t) => t.ttsFirstByteMs !== null).map((t) => t.ttsFirstByteMs!)
			const llmFirstTokens = turnTimings.filter((t) => t.llmFirstTokenMs !== null).map((t) => t.llmFirstTokenMs!)
			const llmCompletes = turnTimings.filter((t) => t.llmCompleteMs !== null).map((t) => t.llmCompleteMs!)
			return {
				turns: turnTimings.length,
				generationToAudioCompleteMs: summarizeSeries(generationToComplete),
				generationToFirstAudioMs: summarizeSeries(generationToFirstAudio),
				turnCompleteToFirstAudioMs: summarizeSeries(turnCompleteToFirstAudio),
				vadEndToTurnCompleteMs: summarizeSeries(vadToTurnComplete),
				vadEndToFirstAudioMs: summarizeSeries(vadToFirstAudio),
				ttsFirstByteMs: summarizeSeries(ttsFirstBytes),
				llmFirstTokenMs: summarizeSeries(llmFirstTokens),
				llmCompleteMs: summarizeSeries(llmCompletes),
				barges: bargeEvents.length,
				softPauses: softPauseEvents.length,
				discarded: discardedTurns,
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

	const turnCompleteToFirstAudio = snapshot.turnTimings
		.filter((t) => t.turnCompleteToFirstAudioMs !== null)
		.map((t) => t.turnCompleteToFirstAudioMs!)
	if (turnCompleteToFirstAudio.length > 0) {
		const avg = Math.round(turnCompleteToFirstAudio.reduce((a, b) => a + b, 0) / turnCompleteToFirstAudio.length)
		telemetry.metrics.distribution('mimic.call.turn_complete_to_first_audio_avg_ms', avg, { unit: 'millisecond' })
	}

	const vadEndToTurnComplete = snapshot.turnTimings
		.filter((t) => t.vadEndToTurnCompleteMs !== null)
		.map((t) => t.vadEndToTurnCompleteMs!)
	if (vadEndToTurnComplete.length > 0) {
		const avg = Math.round(vadEndToTurnComplete.reduce((a, b) => a + b, 0) / vadEndToTurnComplete.length)
		telemetry.metrics.distribution('mimic.call.vad_end_to_turn_complete_avg_ms', avg, { unit: 'millisecond' })
	}

	const vadEndToFirstAudio = snapshot.turnTimings
		.filter((t) => t.vadEndToFirstAudioMs !== null)
		.map((t) => t.vadEndToFirstAudioMs!)
	if (vadEndToFirstAudio.length > 0) {
		const avg = Math.round(vadEndToFirstAudio.reduce((a, b) => a + b, 0) / vadEndToFirstAudio.length)
		telemetry.metrics.distribution('mimic.call.vad_end_to_first_audio_avg_ms', avg, { unit: 'millisecond' })
	}
}
