import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { applyLinearFade, avgMsPerWord, estimateHeardPortion, type WordTiming } from './audio-pacing.js'

describe('applyLinearFade', () => {
	it('fades the tail of a buffer to near-zero', () => {
		const samples = 4800 // 100ms at 48kHz
		const buf = Buffer.alloc(samples * 2)
		for (let i = 0; i < samples; i++) buf.writeInt16LE(10000, i * 2)

		const faded = applyLinearFade(buf, 50)
		const lastSample = faded.readInt16LE(faded.length - 2)
		const midFadeSample = faded.readInt16LE(faded.length - Math.round(2400 * 2))
		assert.ok(Math.abs(lastSample) < 100, `last sample should be near zero, got ${lastSample}`)
		assert.ok(midFadeSample > 3000, `mid-fade should retain energy, got ${midFadeSample}`)
	})

	it('returns buffer unchanged if shorter than fade', () => {
		const buf = Buffer.alloc(100)
		buf.writeInt16LE(5000, 0)
		const result = applyLinearFade(buf, 50)
		assert.equal(result.readInt16LE(0), 5000)
	})
})

/** Builds an evenly spaced timeline: word i spans [i*ms, (i+1)*ms). */
function evenTimeline(words: string[], msPerWord: number): WordTiming[] {
	return words.map((word, i) => ({ word, startMs: i * msPerWord, endMs: (i + 1) * msPerWord }))
}

describe('estimateHeardPortion', () => {
	it('returns empty when no draft', () => {
		assert.equal(estimateHeardPortion('', 1000), '')
	})

	it('returns empty when nothing has played', () => {
		assert.equal(estimateHeardPortion('anything here', 0), '')
		assert.equal(estimateHeardPortion('anything here', 0, evenTimeline(['anything', 'here'], 300)), '')
	})

	describe('with a word timeline', () => {
		it('counts only words whose playback finished', () => {
			const draft = 'one two three four five'
			const timeline = evenTimeline(draft.split(' '), 300)
			// 650 ms: "one" (ends 300) and "two" (ends 600) finished; "three" ends at 900.
			assert.equal(estimateHeardPortion(draft, 650, timeline), 'one two')
		})

		it('uses the timeline over the average-rate fallback', () => {
			const draft = 'one two three four five'
			// Fast speech: 100 ms per word. The fallback would only credit 1 word for 500 ms.
			const timeline = evenTimeline(draft.split(' '), 100)
			assert.equal(estimateHeardPortion(draft, 500, timeline), 'one two three four five')
		})

		it('treats a word that is mid-playback as unheard', () => {
			const draft = 'one two three'
			const timeline = evenTimeline(draft.split(' '), 300)
			assert.equal(estimateHeardPortion(draft, 299, timeline), '')
			assert.equal(estimateHeardPortion(draft, 300, timeline), 'one')
		})

		it('never credits more words than the draft contains', () => {
			const draft = 'one two'
			const timeline = evenTimeline(['one', 'two', 'three', 'four'], 100)
			assert.equal(estimateHeardPortion(draft, 10_000, timeline), 'one two')
		})

		it('snaps the heard words back to a clause boundary', () => {
			const draft = 'Covers liability. Also umbrella and flood coverage.'
			const timeline = evenTimeline(draft.split(' '), 200)
			// 4 words heard ("Covers liability. Also umbrella") → snaps to the period.
			assert.equal(estimateHeardPortion(draft, 800, timeline), 'Covers liability.')
		})
	})

	describe('without a timeline (average-rate fallback)', () => {
		it('credits one word per avgMsPerWord', () => {
			const draft = 'one two three four'
			assert.match(estimateHeardPortion(draft, 2 * avgMsPerWord), /^one two/)
		})

		const boundarySnappingCases = [
			{
				description: 'snaps to period boundary',
				draft: 'Covers liability. Also umbrella and flood coverage.',
				wordsHeard: 4,
				expected: 'Covers liability.',
			},
			{
				description: 'snaps to comma boundary',
				draft: 'Covers liability, umbrella and flood',
				wordsHeard: 3,
				expected: 'Covers liability,',
			},
			{
				description: 'snaps to em dash boundary',
				draft: 'The policy — which is comprehensive — covers everything',
				wordsHeard: 4,
				expected: 'The policy —',
			},
			{
				description: 'falls back to raw slice when no boundary in range',
				draft: 'one two three four five',
				wordsHeard: 2,
				expected: 'one two',
			},
		]

		for (const { description, draft, wordsHeard, expected } of boundarySnappingCases) {
			it(`boundary snapping: ${description}`, () => {
				assert.equal(estimateHeardPortion(draft, wordsHeard * avgMsPerWord), expected)
			})
		}
	})
})
