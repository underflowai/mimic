/**
 * Playback tracker transform.
 *
 * Passthrough Transform that accounts for bytes and milliseconds of
 * PCM flowing toward the transport. Also maintains a rolling tail
 * buffer used to build the fade-out tail on interrupt.
 *
 * Exposes `snapshot()` for the heard-portion estimator and
 * `buildFadeTail()` which returns a faded copy of the most recent
 * `interruptDrainMs` of PCM. The tail buffer is intentionally small —
 * bounded by `maxRecentBytes` — so even long responses do not grow
 * memory.
 */

import { Transform, type TransformCallback } from 'node:stream'

import {
	applyLinearFade,
	avgMsPerWord,
	interruptDrainMs,
	interruptFadeMs,
	maxChunkBytes,
	progressMarkIntervalBytes,
	ttsBytesPerMs,
} from '../../shared/audio-pacing.js'
import type { PlaybackProgress } from './types.js'

export interface PlaybackTracker extends Transform {
	snapshot(): PlaybackProgress
	/** Build a faded copy of the trailing buffer for interrupt drain. */
	buildFadeTail(drainMs?: number, fadeMs?: number): Buffer[]
	/** Reset internal counters (between turns). */
	reset(): void
	/** Resolves with the first-audio timestamp; rejects if transform ends without data. */
	readonly firstChunk: Promise<number>
}

export function createPlaybackTracker(): PlaybackTracker {
	let sentMs = 0
	let sentBytes = 0
	let started = false
	let nextProgressMarkAt = progressMarkIntervalBytes
	let confirmedWordsPlayed = 0
	let recentChunks: Buffer[] = []
	let recentTotal = 0
	const maxRecentBytes = Math.round(interruptDrainMs * ttsBytesPerMs)
	let firstChunkResolve!: (at: number) => void
	let firstChunkReject!: (err: Error) => void
	const firstChunk = new Promise<number>((resolve, reject) => {
		firstChunkResolve = resolve
		firstChunkReject = reject
	})

	function track(chunk: Buffer) {
		if (!started) {
			started = true
			firstChunkResolve(Date.now())
		}
		sentMs += chunk.length / ttsBytesPerMs
		sentBytes += chunk.length

		recentChunks.push(chunk)
		recentTotal += chunk.length
		while (recentTotal > maxRecentBytes && recentChunks.length > 1) {
			recentTotal -= recentChunks.shift()!.length
		}

		if (sentBytes >= nextProgressMarkAt) {
			confirmedWordsPlayed = Math.floor(sentMs / avgMsPerWord)
			nextProgressMarkAt += progressMarkIntervalBytes
		}
	}

	const transform = new Transform({
		writableObjectMode: false,
		readableObjectMode: false,
		transform(chunk: Buffer, _encoding, callback: TransformCallback) {
			if (!Buffer.isBuffer(chunk)) {
				callback(new TypeError('playback-tracker expected Buffer chunks'))
				return
			}
			track(chunk)
			callback(null, chunk)
		},
		flush(callback) {
			if (!started) firstChunkReject(new Error('no audio passed through tracker'))
			callback()
		},
		destroy(err, callback) {
			if (!started) firstChunkReject(err ?? new Error('tracker destroyed before first chunk'))
			callback(err)
		},
	})

	const tracker = transform as PlaybackTracker
	tracker.snapshot = () => ({ sentMs, sentBytes, confirmedWordsPlayed, started })
	tracker.buildFadeTail = (drainMs = interruptDrainMs, fadeMs = interruptFadeMs) => {
		if (recentChunks.length === 0) return []
		const drainBytes = Math.round(drainMs * ttsBytesPerMs)
		const combined = Buffer.concat(recentChunks)
		const tail = combined.subarray(Math.max(0, combined.length - drainBytes))
		if (tail.length === 0) return []
		const faded = applyLinearFade(tail, fadeMs)
		const frames: Buffer[] = []
		for (let offset = 0; offset < faded.length; offset += maxChunkBytes) {
			frames.push(Buffer.from(faded.subarray(offset, Math.min(offset + maxChunkBytes, faded.length))))
		}
		recentChunks = []
		recentTotal = 0
		return frames
	}
	tracker.reset = () => {
		sentMs = 0
		sentBytes = 0
		started = false
		nextProgressMarkAt = progressMarkIntervalBytes
		confirmedWordsPlayed = 0
		recentChunks = []
		recentTotal = 0
	}
	Object.defineProperty(tracker, 'firstChunk', {
		value: firstChunk,
		writable: false,
		enumerable: false,
		configurable: false,
	})

	// Prevent unhandled-rejection if no consumer awaits `firstChunk`.
	firstChunk.catch(() => {})

	return tracker
}
