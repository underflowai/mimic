/**
 * Latency budgets — per-stage p50/p95 targets evaluated per call.
 *
 * The per-stage distributions in `metrics.ts` previously informed nothing
 * automatically. Each call is now scored against this budget table at
 * shutdown; violations emit a `mimic.latency_budget.violation` metric
 * (stage + percentile attributes) and are logged, so a regression in any
 * stage shows up as a rate change instead of being discovered by ear.
 *
 * Budgets are targets, not SLAs — p50 breaches on a single call are noisy
 * by nature, which is why evaluation requires a minimum sample count and
 * alerts are rate-based downstream.
 */

import type { TurnTiming } from './metrics.js'

export interface LatencyBudget {
	/** Field on TurnTiming this budget constrains. */
	stage: LatencyStage
	p50Ms: number
	p95Ms: number
}

export type LatencyStage =
	| 'vadEndToTurnCompleteMs'
	| 'vadEndToFirstAudioMs'
	| 'turnCompleteToFirstAudioMs'
	| 'ttsFirstByteMs'
	| 'llmFirstTokenMs'
	| 'generationToFirstAudioMs'

export interface LatencyBudgetViolation {
	stage: LatencyStage
	percentile: 'p50' | 'p95'
	budgetMs: number
	observedMs: number
	samples: number
}

/** Below this many samples for a stage, the call is too short to judge. */
export const budgetMinSamples = 3

/**
 * Targets. `vadEndToFirstAudioMs` p50 ≤ 350ms is the headline number —
 * the full silence the caller experiences between finishing their turn
 * and hearing the agent. `vadEndToTurnCompleteMs` is the EOT-gate share
 * of that window (what early commit attacks).
 */
export const latencyBudgets: readonly LatencyBudget[] = [
	{ stage: 'vadEndToTurnCompleteMs', p50Ms: 250, p95Ms: 800 },
	{ stage: 'vadEndToFirstAudioMs', p50Ms: 350, p95Ms: 1000 },
	{ stage: 'turnCompleteToFirstAudioMs', p50Ms: 300, p95Ms: 900 },
	{ stage: 'ttsFirstByteMs', p50Ms: 200, p95Ms: 500 },
	{ stage: 'llmFirstTokenMs', p50Ms: 450, p95Ms: 1200 },
	{ stage: 'generationToFirstAudioMs', p50Ms: 800, p95Ms: 2000 },
]

function percentile(sorted: number[], fraction: number) {
	const index = Math.min(Math.ceil(sorted.length * fraction) - 1, sorted.length - 1)
	return sorted[Math.max(index, 0)]
}

export function evaluateLatencyBudgets(
	turnTimings: readonly TurnTiming[],
	budgets: readonly LatencyBudget[] = latencyBudgets,
): LatencyBudgetViolation[] {
	const violations: LatencyBudgetViolation[] = []
	for (const budget of budgets) {
		const values = turnTimings
			.map((timing) => timing[budget.stage])
			.filter((value): value is number => value !== null)
			.sort((a, b) => a - b)
		if (values.length < budgetMinSamples) continue

		const p50 = percentile(values, 0.5)
		const p95 = percentile(values, 0.95)
		if (p50 > budget.p50Ms) {
			violations.push({
				stage: budget.stage,
				percentile: 'p50',
				budgetMs: budget.p50Ms,
				observedMs: p50,
				samples: values.length,
			})
		}
		if (p95 > budget.p95Ms) {
			violations.push({
				stage: budget.stage,
				percentile: 'p95',
				budgetMs: budget.p95Ms,
				observedMs: p95,
				samples: values.length,
			})
		}
	}
	return violations
}
