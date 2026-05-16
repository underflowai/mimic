import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createCallMetrics, type TurnTiming } from './metrics.js'

function tt(partial: {
	turnId: number
	generationToAudioCompleteMs: number
	generationToFirstAudioMs: number | null
	turnCompleteToFirstAudioMs: number | null
}): TurnTiming {
	return {
		kind: 'fresh',
		vadEndToTurnCompleteMs: null,
		vadEndToFirstAudioMs: null,
		ttsFirstByteMs: null,
		llmFirstTokenMs: null,
		llmCompleteMs: null,
		...partial,
	}
}

describe('createCallMetrics', () => {
	it('starts with empty collections and zero discarded', () => {
		const m = createCallMetrics()
		assert.deepEqual(m.turnTimings, [])
		assert.deepEqual(m.bargeEvents, [])
		assert.deepEqual(m.speculationEvents, [])
		assert.equal(m.discardedTurns, 0)
	})

	it('records turn timings with turnCompleteToFirstAudioMs', () => {
		const m = createCallMetrics()
		m.recordTurnTiming({
			...tt({
				turnId: 0,
				generationToAudioCompleteMs: 120,
				generationToFirstAudioMs: 200,
				turnCompleteToFirstAudioMs: 150,
			}),
			vadEndToTurnCompleteMs: 40,
			vadEndToFirstAudioMs: 190,
			llmFirstTokenMs: 50,
			llmCompleteMs: 80,
		})
		m.recordTurnTiming(
			tt({
				turnId: 1,
				generationToAudioCompleteMs: 90,
				generationToFirstAudioMs: null,
				turnCompleteToFirstAudioMs: null,
			}),
		)
		assert.equal(m.turnTimings.length, 2)
		assert.equal(m.turnTimings[0].kind, 'fresh')
		assert.equal(m.turnTimings[0].turnCompleteToFirstAudioMs, 150)
		assert.equal(m.turnTimings[0].vadEndToTurnCompleteMs, 40)
		assert.equal(m.turnTimings[1].generationToFirstAudioMs, null)
		assert.equal(m.turnTimings[1].kind, 'fresh')
		assert.equal(m.turnTimings[1].turnCompleteToFirstAudioMs, null)
	})

	it('records barge events', () => {
		const m = createCallMetrics()
		m.recordBarge({ outcome: 'interrupted', wordCount: 5, elapsedMs: 300 })
		assert.equal(m.bargeEvents.length, 1)
		assert.equal(m.bargeEvents[0].outcome, 'interrupted')
	})

	it('records speculation events', () => {
		const m = createCallMetrics()
		m.recordSpeculation({
			outcome: 'promoted',
			speculativeTranscript: 'test',
			finalTranscript: 'test final',
			speculationDurationMs: 150,
		})
		assert.equal(m.speculationEvents.length, 1)
		assert.equal(m.speculationEvents[0].outcome, 'promoted')
	})

	it('increments discarded count', () => {
		const m = createCallMetrics()
		m.incrementDiscarded()
		m.incrementDiscarded()
		assert.equal(m.discardedTurns, 2)
	})

	it('snapshot returns a copy of current state', () => {
		const m = createCallMetrics()
		m.recordTurnTiming(
			tt({
				turnId: 0,
				generationToAudioCompleteMs: 100,
				generationToFirstAudioMs: 150,
				turnCompleteToFirstAudioMs: 80,
			}),
		)
		m.incrementDiscarded()

		const snap = m.snapshot()
		assert.equal(snap.turnTimings.length, 1)
		assert.equal(snap.discardedTurns, 1)

		m.recordTurnTiming(
			tt({
				turnId: 1,
				generationToAudioCompleteMs: 200,
				generationToFirstAudioMs: 300,
				turnCompleteToFirstAudioMs: 120,
			}),
		)
		assert.equal(snap.turnTimings.length, 1, 'snapshot should be a frozen copy')
	})

	it('summarize computes latency stats', () => {
		const m = createCallMetrics()
		m.recordTurnTiming(
			tt({
				turnId: 0,
				generationToAudioCompleteMs: 100,
				generationToFirstAudioMs: 200,
				turnCompleteToFirstAudioMs: 150,
				// end-to-turn 20, end-to-first-audio 170
			}),
		)
		m.recordTurnTiming(
			tt({
				turnId: 1,
				generationToAudioCompleteMs: 300,
				generationToFirstAudioMs: 400,
				turnCompleteToFirstAudioMs: 50,
			}),
		)
		m.recordTurnTiming({
			...tt({
				turnId: 2,
				generationToAudioCompleteMs: 200,
				generationToFirstAudioMs: null,
				turnCompleteToFirstAudioMs: null,
			}),
			vadEndToTurnCompleteMs: 25,
			vadEndToFirstAudioMs: 225,
		})
		m.recordTurnTiming(
			tt({
				turnId: 3,
				generationToAudioCompleteMs: 180,
				generationToFirstAudioMs: null,
				turnCompleteToFirstAudioMs: null,
			}),
		)
		m.recordBarge({ outcome: 'interrupted', wordCount: 3, elapsedMs: 100 })
		m.incrementDiscarded()

		const s = m.summarize()
		assert.equal(s.turns, 4)
		assert.equal(s.generationToAudioCompleteMs.avg, 195)
		assert.equal(s.generationToAudioCompleteMs.p50, 180)
		assert.equal(s.generationToAudioCompleteMs.min, 100)
		assert.equal(s.generationToAudioCompleteMs.max, 300)
		assert.equal(s.generationToFirstAudioMs.avg, 300)
		assert.equal(s.generationToFirstAudioMs.p50, 200)
		assert.equal(s.generationToFirstAudioMs.min, 200)
		assert.equal(s.generationToFirstAudioMs.max, 400)
		assert.equal(s.turnCompleteToFirstAudioMs.avg, 100)
		assert.equal(s.turnCompleteToFirstAudioMs.p50, 50)
		assert.equal(s.turnCompleteToFirstAudioMs.min, 50)
		assert.equal(s.turnCompleteToFirstAudioMs.max, 150)
		assert.equal(s.vadEndToTurnCompleteMs.avg, 25)
		assert.equal(s.vadEndToTurnCompleteMs.p50, 25)
		assert.equal(s.vadEndToTurnCompleteMs.min, 25)
		assert.equal(s.vadEndToTurnCompleteMs.max, 25)
		assert.equal(s.vadEndToFirstAudioMs.avg, 225)
		assert.equal(s.vadEndToFirstAudioMs.p50, 225)
		assert.equal(s.vadEndToFirstAudioMs.min, 225)
		assert.equal(s.vadEndToFirstAudioMs.max, 225)
		assert.equal(s.barges, 1)
		assert.equal(s.discarded, 1)
	})

	it('summarize handles empty metrics', () => {
		const m = createCallMetrics()
		const s = m.summarize()
		assert.equal(s.turns, 0)
		assert.equal(s.generationToAudioCompleteMs.avg, 0)
		assert.equal(s.generationToAudioCompleteMs.p50, 0)
		assert.equal(s.turnCompleteToFirstAudioMs.avg, 0)
		assert.equal(s.turnCompleteToFirstAudioMs.p50, 0)
		assert.equal(s.barges, 0)
	})

	it('percentiles are correct for single-element series', () => {
		const m = createCallMetrics()
		m.recordTurnTiming(
			tt({ turnId: 0, generationToAudioCompleteMs: 42, generationToFirstAudioMs: 100, turnCompleteToFirstAudioMs: 80 }),
		)
		const s = m.summarize()
		assert.equal(s.generationToAudioCompleteMs.p50, 42)
		assert.equal(s.generationToAudioCompleteMs.p95, 42)
		assert.equal(s.generationToFirstAudioMs.p50, 100)
		assert.equal(s.generationToFirstAudioMs.p95, 100)
	})

	it('percentiles are correct for two-element series', () => {
		const m = createCallMetrics()
		m.recordTurnTiming(
			tt({
				turnId: 0,
				generationToAudioCompleteMs: 100,
				generationToFirstAudioMs: 200,
				turnCompleteToFirstAudioMs: 50,
			}),
		)
		m.recordTurnTiming(
			tt({
				turnId: 1,
				generationToAudioCompleteMs: 300,
				generationToFirstAudioMs: 400,
				turnCompleteToFirstAudioMs: 150,
			}),
		)
		const s = m.summarize()
		assert.equal(s.generationToAudioCompleteMs.p50, 100)
		assert.equal(s.generationToAudioCompleteMs.p95, 300)
		assert.equal(s.generationToFirstAudioMs.p50, 200)
		assert.equal(s.generationToFirstAudioMs.p95, 400)
	})

	it('percentiles pick the correct value for 20-element series', () => {
		const m = createCallMetrics()
		for (let i = 1; i <= 20; i++) {
			m.recordTurnTiming(
				tt({
					turnId: i,
					generationToAudioCompleteMs: i * 10,
					generationToFirstAudioMs: i * 10,
					turnCompleteToFirstAudioMs: i * 10,
				}),
			)
		}
		const s = m.summarize()
		assert.equal(s.generationToAudioCompleteMs.p50, 100)
		assert.equal(s.generationToAudioCompleteMs.p95, 190)
	})
})
