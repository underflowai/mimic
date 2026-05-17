/**
 * LiveKit-backed audio sink.
 *
 * Wraps the call-scoped `AudioSource` from `@livekit/rtc-node` in a
 * Node `Writable` so the outbound pipeline can treat LiveKit as its
 * backpressure boundary: `_write()` awaits `captureFrame(...)`, which
 * blocks while the underlying `AudioSource` queue is full.
 *
 * Each turn acquires a fresh sink via `createLiveKitTransport().createSink()`.
 * The underlying `AudioSource` lives for the whole call; only the
 * `Writable` wrapper is one-shot. Destroying the wrapper does **not**
 * close the AudioSource — the transport's `close()` call does that.
 *
 * The sink also exposes imperative helpers (`clearQueue`,
 * `waitForPlayout`, `writeFrameDirect`) that the turn machine uses on
 * interrupt and when confirming playout.
 */

import { Writable, type WritableOptions } from 'node:stream'

import { AudioFrame, type AudioSource } from '@livekit/rtc-node'

import { createLogger } from '#engine/logger.js'

import { ttsSampleRate } from '../../shared/audio-pacing.js'
import type { AudioSink, AudioTransport } from './types.js'

const log = createLogger('mimic:livekit-sink')

interface LiveKitTransportOptions {
	audioSource: AudioSource
	/** Prefix for diagnostic logs (e.g. call id / log prefix). */
	logPrefix?: string
}

interface LiveKitSinkOptions extends WritableOptions {
	source: AudioSource
	label: string
}

function toAlignedPcm16(chunk: Buffer, context: { label?: string; prefix?: string }): Buffer | null {
	if (chunk.byteLength === 0) return null
	if (chunk.byteLength % 2 === 0) return chunk

	const trimmedLength = chunk.byteLength - 1
	log.warn(
		{ ...context, byteLength: chunk.byteLength, trimmedLength },
		'dropping trailing odd byte from PCM16 chunk',
	)
	if (trimmedLength <= 0) return null
	return chunk.subarray(0, trimmedLength)
}

/**
 * Construct the call-scoped transport. Callers pass in the LiveKit
 * `AudioSource` they already created and published on a
 * `LocalAudioTrack`; the transport hands out per-turn sinks and a
 * pair of helpers for backchannel / idle-query behaviour.
 */
export function createLiveKitTransport(options: LiveKitTransportOptions): AudioTransport {
	const { audioSource, logPrefix } = options
	const prefix = logPrefix ? `[${logPrefix}]` : ''
	let sinkCounter = 0
	let activeSink: LiveKitWritable | null = null

	function bufferToFrame(chunk: Buffer): AudioFrame | null {
		const aligned = toAlignedPcm16(chunk, { prefix })
		if (!aligned) return null
		const samples = new Int16Array(aligned.byteLength / 2)
		samples.set(new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2))
		return new AudioFrame(samples, ttsSampleRate, 1, samples.length)
	}

	async function captureFrame(chunk: Buffer): Promise<void> {
		if (audioSource.closed) return
		const frame = bufferToFrame(chunk)
		if (!frame) return
		try {
			await audioSource.captureFrame(frame)
		} catch (err) {
			if (audioSource.closed) return
			log.error({ prefix, err }, 'captureFrame failed')
		}
	}

	function createSink(): AudioSink {
		if (activeSink) {
			activeSink.cancel()
			if (!activeSink.destroyed) activeSink.destroy()
		}
		if (!audioSource.closed) audioSource.clearQueue()
		const label = `sink-${++sinkCounter}`
		activeSink = new LiveKitWritable({
			source: audioSource,
			label,
			highWaterMark: 1,
			decodeStrings: false,
		})
		return activeSink
	}

	function playBackchannelFrame(chunk: Buffer) {
		if (audioSource.closed) return
		void captureFrame(chunk)
	}

	return {
		createSink,
		playBackchannelFrame,
		isOpen: () => !audioSource.closed,
		async close() {
			if (audioSource.closed) return
			try {
				await audioSource.close()
			} catch (err) {
				log.error({ prefix, err }, 'failed to close AudioSource')
			}
		},
	}
}

class LiveKitWritable extends Writable implements AudioSink {
	#source: AudioSource
	#label: string
	#captureChain: Promise<void> = Promise.resolve()
	#cancelled = false

	constructor(options: LiveKitSinkOptions) {
		super({ highWaterMark: options.highWaterMark ?? 1, decodeStrings: false })
		this.#source = options.source
		this.#label = options.label
	}

	#framesFromBuffer(chunk: Buffer): AudioFrame | null {
		const aligned = toAlignedPcm16(chunk, { label: this.#label })
		if (!aligned) return null
		const samples = new Int16Array(aligned.byteLength / 2)
		samples.set(new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2))
		return new AudioFrame(samples, ttsSampleRate, 1, samples.length)
	}

	cancel(): void {
		this.#cancelled = true
	}

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
		if (!Buffer.isBuffer(chunk)) {
			callback(new TypeError('LiveKit sink expected Buffer chunks'))
			return
		}
		if (this.#cancelled || this.destroyed || this.#source.closed) {
			callback()
			return
		}
		const frame = this.#framesFromBuffer(chunk)
		if (!frame) {
			callback()
			return
		}
		this.#captureChain = this.#captureChain
			.then(() => {
				if (this.#cancelled || this.destroyed || this.#source.closed) return
				return this.#source.captureFrame(frame)
			})
			.then(
				() => callback(),
				(err) => {
					if (this.#source.closed || this.#cancelled) {
						callback()
						return
					}
					log.error({ label: this.#label, err }, 'captureFrame failed')
					callback(err instanceof Error ? err : new Error(String(err)))
				},
			)
	}

	override _final(callback: (err?: Error | null) => void): void {
		this.#captureChain.then(() => callback()).catch(() => callback())
	}

	override _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
		this.#cancelled = true
		this.#captureChain.catch(() => {})
		callback(err)
	}

	async waitForPlayout(): Promise<void> {
		await this.#captureChain.catch(() => {})
		if (this.#source.closed) return
		try {
			await this.#source.waitForPlayout()
		} catch (err) {
			if (!this.#source.closed) log.error({ label: this.#label, err }, 'waitForPlayout failed')
		}
	}

	clearQueue(): void {
		if (this.#source.closed) return
		this.#source.clearQueue()
	}

	async writeFrameDirect(chunk: Buffer): Promise<void> {
		if (this.#cancelled || this.#source.closed) return
		const frame = this.#framesFromBuffer(chunk)
		if (!frame) return
		this.#captureChain = this.#captureChain.then(() => {
			if (this.#cancelled || this.#source.closed) return
			return this.#source.captureFrame(frame)
		})
		try {
			await this.#captureChain
		} catch (err) {
			if (!this.#source.closed) log.error({ label: this.#label, err }, 'writeFrameDirect failed')
		}
	}
}
