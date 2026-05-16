import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createVoiceActivityDetector } from './vad.js'

describe('createVoiceActivityDetector', () => {
	it('creates and destroys without error', async () => {
		const vad = await createVoiceActivityDetector()
		vad.destroy()
	})

	it('processAudio accepts PCM16 buffer without throwing', async () => {
		const vad = await createVoiceActivityDetector()
		const silent = Buffer.alloc(1024)
		vad.processAudio(silent)
		vad.destroy()
	})

	it('does not fire speechStart on silence', async () => {
		let fired = false
		const vad = await createVoiceActivityDetector({
			onSpeechStart: () => {
				fired = true
			},
		})

		for (let i = 0; i < 20; i++) {
			vad.processAudio(Buffer.alloc(1024))
		}
		await new Promise((r) => setTimeout(r, 200))

		assert.equal(fired, false, 'should not fire on silence')
		vad.destroy()
	})

	it('does not fire speechStart on pure tone (non-speech audio)', async () => {
		let fired = false
		const vad = await createVoiceActivityDetector({
			onSpeechStart: () => {
				fired = true
			},
		})

		for (let i = 0; i < 30; i++) {
			const buf = Buffer.alloc(1024)
			for (let j = 0; j < 512; j++) {
				const sample = Math.round(Math.sin((2 * Math.PI * 440 * (i * 512 + j)) / 16000) * 16000)
				buf.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), j * 2)
			}
			vad.processAudio(buf)
		}
		await new Promise((r) => setTimeout(r, 200))

		assert.equal(fired, false, 'should not fire on pure tone')
		vad.destroy()
	})
})
