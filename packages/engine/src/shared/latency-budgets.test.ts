import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { budgetMinSamples, evaluateLatencyBudgets, latencyBudgets } from './latency-budgets.js'
import type { TurnTiming } from './metrics.js'

function timing(overrides: Partial<TurnTiming>): TurnTiming {
	return {
		turnId: 0,
		kind: 'fresh',
		generationToAudioCompleteMs: 1000,
		generationToFirstAudioMs: null,
		turnCompleteToFirstAudioMs: null,
		vadEndToTurnCompleteMs: null,
		vadEndToFirstAudioMs: null,
		ttsFirstByteMs: null,
		llmFirstTokenMs: null,
		llmCompleteMs: null,
		...overrides,
	}
}

describe('evaluateLatencyBudgets', () => {
	it('returns no violations when every stage is within budget', () => {
		const timings = Array.from({ length: 5 }, (_, i) =>
			timing({
				turnId: i,
				vadEndToTurnCompleteMs: 200,
				vadEndToFirstAudioMs: 300,
				turnCompleteToFirstAudioMs: 250,
				ttsFirstByteMs: 150,
				llmFirstTokenMs: 400,
				generationToFirstAudioMs: 700,
			}),
		)
		assert.deepEqual(evaluateLatencyBudgets(timings), [])
	})

	it('flags a p50 breach for a consistently slow stage', () => {
		const timings = Array.from({ length: 5 }, (_, i) => timing({ turnId: i, vadEndToFirstAudioMs: 900 }))
		const violations = evaluateLatencyBudgets(timings)
		const stages = violations.map((v) => `${v.stage}:${v.percentile}`)
		assert.ok(stages.includes('vadEndToFirstAudioMs:p50'))
		const p50 = violations.find((v) => v.stage === 'vadEndToFirstAudioMs' && v.percentile === 'p50')
		assert.equal(p50?.observedMs, 900)
		assert.equal(p50?.budgetMs, 350)
		assert.equal(p50?.samples, 5)
	})

	it('flags a p95-only breach when the median is fine but the tail is bad', () => {
		const values = [200, 210, 220, 230, 240, 250, 260, 270, 280, 3000]
		const timings = values.map((v, i) => timing({ turnId: i, vadEndToFirstAudioMs: v }))
		const violations = evaluateLatencyBudgets(timings)
		assert.deepEqual(
			violations.map((v) => `${v.stage}:${v.percentile}`),
			['vadEndToFirstAudioMs:p95'],
		)
	})

	it('skips stages with fewer samples than the minimum', () => {
		const timings = Array.from({ length: budgetMinSamples - 1 }, (_, i) =>
			timing({ turnId: i, vadEndToFirstAudioMs: 5000 }),
		)
		assert.deepEqual(evaluateLatencyBudgets(timings), [])
	})

	it('ignores null samples entirely', () => {
		const timings = [
			...Array.from({ length: 4 }, (_, i) => timing({ turnId: i, ttsFirstByteMs: 100 })),
			timing({ turnId: 99, ttsFirstByteMs: null }),
		]
		assert.deepEqual(evaluateLatencyBudgets(timings), [])
	})

	it('budget table covers the headline stages', () => {
		const stages = latencyBudgets.map((b) => b.stage)
		assert.ok(stages.includes('vadEndToFirstAudioMs'))
		assert.ok(stages.includes('vadEndToTurnCompleteMs'))
		assert.ok(stages.includes('ttsFirstByteMs'))
	})
})
