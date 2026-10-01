/**
 * Frame alignment transform.
 *
 * Re-chunks an incoming PCM byte stream into fixed-size frames. TTS
 * emits arbitrarily sized PCM blocks; the transport, interrupt drain
 * math, and playback tracker all assume consistent `ttsFrameMs` frames
 * (`ttsFrameBytes` in `shared/audio-format.ts`).
 *
 * The transform applies a short linear fade to the final partial frame
 * on flush so the stream ends smoothly when the source closes naturally.
 */

import { Transform, type TransformCallback } from 'node:stream'

import { ttsFrameBytes } from '../../shared/audio-format.js'
import { applyLinearFade, ttsTailFadeMs } from '../../shared/audio-pacing.js'

interface FrameAlignOptions {
	chunkBytes?: number
	fadeOnFlushMs?: number
}

export function createFrameAlignTransform(options: FrameAlignOptions = {}): Transform {
	const chunkBytes = options.chunkBytes ?? ttsFrameBytes
	const fadeMs = options.fadeOnFlushMs ?? ttsTailFadeMs
	let carry: Buffer | null = null

	return new Transform({
		writableObjectMode: false,
		readableObjectMode: false,
		transform(chunk: Buffer, _encoding, callback: TransformCallback) {
			if (!Buffer.isBuffer(chunk)) {
				callback(new TypeError('frame-align expected Buffer chunks'))
				return
			}

			const combined = carry ? Buffer.concat([carry, chunk]) : chunk
			let offset = 0
			while (combined.length - offset >= chunkBytes) {
				this.push(combined.subarray(offset, offset + chunkBytes))
				offset += chunkBytes
			}
			carry = offset < combined.length ? Buffer.from(combined.subarray(offset)) : null
			callback()
		},
		flush(callback: TransformCallback) {
			if (!carry || carry.length === 0) {
				callback()
				return
			}
			const faded = applyLinearFade(carry, fadeMs)
			carry = null
			this.push(faded)
			callback()
		},
	})
}
