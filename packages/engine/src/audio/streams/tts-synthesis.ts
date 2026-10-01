/**
 * TTS synthesis transform.
 *
 * Consumes `SentenceChunkEvent`s from the upstream sentence chunker and
 * converts them into a PCM byte stream by driving a single
 * `TtsSpeaker.preSendTextForSynthesis` session per turn. Text deltas
 * are accumulated locally and sent to Cartesia at sentence/phrase
 * boundaries using custom buffering (`max_buffer_delay_ms: 0`) so the
 * server generates immediately from each batch.
 *
 * Timing metrics (`firstTokenAt`, `ttsSendAt`, `ttsFirstByteAt`,
 * `firstAudio`) track the first session so TTFAB numbers reflect
 * true user-observed latency. Word timings reported by the speaker are
 * accumulated into `wordTimeline()` for heard-portion estimation.
 */

import { Transform, type TransformCallback } from 'node:stream'

import { createLogger } from '#engine/logger.js'

import type { WordTiming } from '../../shared/audio-pacing.js'
import { isAbortLikeError } from '../../shared/async-utils.js'
import { monotonicClock, type Clock } from '../../shared/clock.js'
import { extractTtsControlTags, speechTagTextCanStream } from '../tts-sanitizer.js'
import type { TtsSpeaker, TtsSynthesisHandle as SpeakerHandle } from '../tts-speaker.js'
import type { SentenceChunkEvent } from './sentence-chunker.js'

const log = createLogger('mimic:tts-stream')

export interface TtsSynthesisHandle {
	transform: Transform
	/** Resolves when the first PCM byte has been emitted downstream. */
	firstAudio: Promise<number>
	/** Timestamp of the first text delta sent to the speaker, or null if none was sent. */
	ttsSendAt: () => number | null
	/** Timestamp the first PCM chunk was emitted. */
	ttsFirstByteAt: () => number | null
	/** Timestamp of the first LLM delta seen by the transform. */
	firstTokenAt: () => number | null
	/** Exact normalized text sent to the TTS speaker across all sessions. */
	textSent: () => string
	/** Word timings reported by the speaker so far, relative to the start of this turn's audio. Live array. */
	wordTimeline: () => readonly WordTiming[]
}

export interface TtsSynthesisOptions {
	tts: TtsSpeaker
	sanitize: (text: string) => string
	logContext?: Record<string, unknown>
	signal?: AbortSignal
	clock?: Clock
}

export function createTtsSynthesisTransform(options: TtsSynthesisOptions): TtsSynthesisHandle {
	const { tts, sanitize } = options
	const clock = options.clock ?? monotonicClock

	let handle: SpeakerHandle | null = null
	let pendingDelta = ''
	let firstTokenAt: number | null = null
	let ttsSendAt: number | null = null
	let ttsFirstByteAt: number | null = null
	let audioEmitCount = 0
	let textSent = ''
	const words: WordTiming[] = []
	let firstAudioResolve!: (at: number) => void
	let firstAudioReject!: (err: Error) => void
	const firstAudio = new Promise<number>((resolve, reject) => {
		firstAudioResolve = resolve
		firstAudioReject = reject
	})

	let abortListener: (() => void) | null = null
	if (options.signal) {
		const onAbort = () => {
			if (handle) tts.interrupt()
		}
		options.signal.addEventListener('abort', onAbort, { once: true })
		abortListener = () => options.signal?.removeEventListener('abort', onAbort)
	}

	function handleAudioChunk(pcm: Buffer, push: (chunk: Buffer) => void) {
		if (audioEmitCount === 0) {
			ttsFirstByteAt = clock.now()
			firstAudioResolve(ttsFirstByteAt)
		}
		audioEmitCount++
		push(pcm)
	}

	function normalizePendingDelta(flush: boolean): string | null {
		if (!flush && !speechTagTextCanStream(pendingDelta)) return null
		return sanitize(extractTtsControlTags(pendingDelta).text)
	}

	function recordTextSent(delta: string) {
		textSent += delta
	}

	async function openHandle(push: (chunk: Buffer) => void, flush: boolean): Promise<'ok' | 'skip' | 'wait' | 'failed'> {
		if (handle) return 'ok'
		const firstDelta = normalizePendingDelta(flush)
		if (firstDelta === null) return 'wait'
		pendingDelta = ''
		if (/^\s*$/.test(firstDelta)) return 'skip'
		try {
			ttsSendAt ??= clock.now()
			handle = await tts.preSendTextForSynthesis(firstDelta, {
				onAudioChunk: (pcm) => handleAudioChunk(pcm, push),
				onWordTimings: (timings) => words.push(...timings),
			})
			recordTextSent(firstDelta)
			return 'ok'
		} catch (err) {
			if (isAbortLikeError(err)) {
				log.info(options.logContext ?? {}, 'TTS interrupted during pre-send setup')
			} else {
				log.error({ ...options.logContext, err }, 'TTS pre-send failed')
			}
			return 'failed'
		}
	}

	async function sendPendingBatch(
		push: (chunk: Buffer) => void,
		flush: boolean,
	): Promise<'ok' | 'skip' | 'wait' | 'failed'> {
		if (!pendingDelta) return 'skip'
		const delta = normalizePendingDelta(flush)
		if (delta === null) return 'wait'
		pendingDelta = ''
		if (/^\s*$/.test(delta)) return 'skip'

		if (!handle) {
			pendingDelta = delta
			return openHandle(push, true)
		}

		handle.pushTextDelta(delta)
		recordTextSent(delta)
		return 'ok'
	}

	async function awaitAudioComplete(currentHandle: SpeakerHandle): Promise<void> {
		if (options.signal?.aborted) return
		await new Promise<void>((resolve) => {
			let settled = false
			const finish = () => {
				if (settled) return
				settled = true
				options.signal?.removeEventListener('abort', finish)
				resolve()
			}
			options.signal?.addEventListener('abort', finish, { once: true })
			currentHandle.audioComplete.then(finish, finish)
		})
	}

	const transform = new Transform({
		writableObjectMode: true,
		readableObjectMode: false,
		async transform(event: unknown, _encoding, callback: TransformCallback) {
			const chunkEvent = normalizeChunkEvent(event)
			if (!chunkEvent) {
				callback()
				return
			}

			const push = (chunk: Buffer) => this.push(chunk)

			if (chunkEvent.type === 'delta') {
				if (!chunkEvent.text) {
					callback()
					return
				}
				firstTokenAt ??= clock.now()
				pendingDelta += chunkEvent.text
				callback()
				return
			}

			const setup = await sendPendingBatch(push, false)
			if (setup === 'failed') {
				callback(new Error('TTS pre-send failed'))
				return
			}
			callback()
		},
		async flush(callback: TransformCallback) {
			try {
				const push = (chunk: Buffer) => this.push(chunk)

				const setup = await openHandle(push, true)
				if (setup === 'failed') {
					callback(new Error('TTS pre-send failed during flush'))
					return
				}

				if (handle) {
					const result = await sendPendingBatch(push, true)
					if (result === 'failed') {
						callback(new Error('TTS pre-send failed during flush'))
						return
					}
					handle.triggerSynthesisStart()
					await awaitAudioComplete(handle)
					handle = null
				}

				if (audioEmitCount === 0) firstAudioReject(new Error('no audio emitted'))
				callback()
			} catch (err) {
				if (isAbortLikeError(err)) {
					callback()
					return
				}
				if (audioEmitCount === 0) firstAudioReject(err instanceof Error ? err : new Error(String(err)))
				callback(err as Error)
			}
		},
		destroy(err, callback) {
			abortListener?.()
			abortListener = null
			if (handle) {
				tts.interrupt()
				handle = null
			}
			if (audioEmitCount === 0) {
				firstAudioReject(err ?? new Error('transform destroyed before audio'))
			}
			callback(err)
		},
	})

	return {
		transform,
		firstAudio,
		ttsSendAt: () => ttsSendAt,
		ttsFirstByteAt: () => ttsFirstByteAt,
		firstTokenAt: () => firstTokenAt,
		textSent: () => textSent,
		wordTimeline: () => words,
	}
}

function normalizeChunkEvent(value: unknown): SentenceChunkEvent | null {
	if (typeof value === 'string') return value.length > 0 ? { type: 'delta', text: value } : null
	if (!value || typeof value !== 'object') return null
	const event = value as { type?: unknown; text?: unknown }
	if (event.type === 'boundary') return { type: 'boundary' }
	if (event.type === 'delta' && typeof event.text === 'string') return { type: 'delta', text: event.text }
	return null
}
