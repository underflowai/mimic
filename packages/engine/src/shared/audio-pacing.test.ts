import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { applyLinearFade, avgMsPerWord, estimateHeardPortion } from './audio-pacing.js'

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

describe('estimateHeardPortion', () => {
	it('returns empty when no draft', () => {
		assert.equal(estimateHeardPortion('', 1000, 0), '')
	})

	it('uses confirmed words when positive', () => {
		const draft = 'one two three four five'
		assert.equal(estimateHeardPortion(draft, 10_000, 2), 'one two')
	})

	it('falls back to timing when no confirmed words', () => {
		const draft = 'one two three four'
		const ms = 2 * avgMsPerWord
		const heard = estimateHeardPortion(draft, ms, 0)
		assert.match(heard, /^one two/)
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
		{
			description: 'returns empty for zero sentMs',
			draft: 'anything here',
			wordsHeard: 0,
			expected: '',
		},
	]

	for (const { description, draft, wordsHeard, expected } of boundarySnappingCases) {
		it(`boundary snapping: ${description}`, () => {
			const sentMs = wordsHeard === 0 ? 0 : wordsHeard * avgMsPerWord
			assert.equal(estimateHeardPortion(draft, sentMs, 0), expected)
		})
	}
})
