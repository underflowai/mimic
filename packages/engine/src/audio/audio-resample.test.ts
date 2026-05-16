import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
	convertPcm16BufferToFloat32Samples,
	resampleFloat32LinearSamples,
	resamplePcm16BufferToFloat32Samples,
} from './audio-resample.js'

describe('audio-resample', () => {
	it('converts pcm16 buffers to float32 samples', () => {
		const pcm = Buffer.alloc(6)
		pcm.writeInt16LE(-32768, 0)
		pcm.writeInt16LE(0, 2)
		pcm.writeInt16LE(32767, 4)

		const samples = convertPcm16BufferToFloat32Samples(pcm)
		assert.equal(samples.length, 3)
		assert.equal(samples[0], -1)
		assert.equal(samples[1], 0)
		assert.ok(samples[2] > 0.9999)
	})

	it('returns copied samples when sample rate is unchanged', () => {
		const input = new Float32Array([0, 0.5, 1])
		const output = resampleFloat32LinearSamples(input, 16_000, 16_000)

		assert.deepEqual(Array.from(output), [0, 0.5, 1])
		assert.notEqual(output, input)
	})

	it('resamples float32 samples linearly between sample rates', () => {
		const input = new Float32Array([0, 0.5, 1, 0.5])
		const output = resampleFloat32LinearSamples(input, 4, 6)

		assert.equal(output.length, 6)
		assert.equal(output[0], 0)
		assert.ok(output[1] > 0.3 && output[1] < 0.35)
		assert.ok(output[2] > 0.65 && output[2] < 0.7)
		assert.equal(output[3], 1)
	})

	it('resamples pcm16 buffers directly to float32 at target sample rate', () => {
		const pcm = Buffer.alloc(8)
		pcm.writeInt16LE(0, 0)
		pcm.writeInt16LE(16384, 2)
		pcm.writeInt16LE(32767, 4)
		pcm.writeInt16LE(16384, 6)

		const output = resamplePcm16BufferToFloat32Samples(pcm, 4, 6)
		assert.equal(output.length, 6)
		assert.equal(output[0], 0)
		assert.ok(output[3] > 0.99)
	})
})
