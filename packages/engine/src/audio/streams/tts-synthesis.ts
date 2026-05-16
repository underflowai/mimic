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
 * true user-observed latency.
 */

import { Transform, type TransformCallback } from 'node:stream'

import { createLogger } from '#engine/logger.js'

import { isAbortLikeError } from '../../shared/async-utils.js'
import { extractTtsControlTags, speechTagTextCanStream } from '../tts-sanitizer.js'
import type { TtsSpeaker } from '../tts-speaker.js'
import type { SentenceChunkEvent } from './sentence-chunker.js'

const log = createLogger('mimic:tts-stream')

export interface TtsSynthesisHandle {
	transform: Transform
	/** Resolves when the first PCM byte has been emitted downstream. */
	firstAudio: Promise<number>
	/** Resolves with the sanitized TTS delta send timestamp, or null if no audio was sent. */
	ttsSendAt: () => number | null
	/** Resolves with the timestamp the first PCM chunk was emitted. */
	ttsFirstByteAt: () => number | null
	/** Resolves with the first LLM delta timestamp seen by the transform. */
	firstTokenAt: () => number | null
	/** Exact normalized text sent to the TTS speaker across all sessions. */
	textSent: () => string
}

export interface TtsSynthesisOptions {
	tts: TtsSpeaker
	sanitize: (text: string) => string
	/**
	 * Retained for test/backwards compatibility. Production token streams
	 * should use the sentence chunker; this transform sends on boundaries.
	 */
	flushThreshold?: number
	/** Optional logger context (e.g. turnId). */
	logContext?: Record<string, unknown>
	/** Abort signal used to interrupt the underlying TTS handle. */
	signal?: AbortSignal
}

type TtsHandle = Awaited<ReturnType<TtsSpeaker['preSendTextForSynthesis']>>

export function createTtsSynthesisTransform(options: TtsSynthesisOptions): TtsSynthesisHandle {
	const { tts, sanitize } = options

	let handle: TtsHandle | null = null
	let pendingDelta = ''
	let firstTokenAt: number | null = null
	let ttsSendAt: number | null = null
	let ttsFirstByteAt: number | null = null
	let audioEmitCount = 0
	let textSent = ''
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
			ttsFirstByteAt = Date.now()
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
			ttsSendAt ??= Date.now()
			handle = await tts.preSendTextForSynthesis(firstDelta, (pcm) => {
				handleAudioChunk(pcm, push)
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

	async function awaitAudioComplete(currentHandle: TtsHandle): Promise<void> {
		if (options.signal?.aborted) return
		await new Promise<void>((resolve) => {
			let settled = false
			const onAbort = () => {
				if (settled) return
				settled = true
				options.signal?.removeEventListener('abort', onAbort)
				resolve()
			}
			options.signal?.addEventListener('abort', onAbort, { once: true })
			currentHandle.audioComplete.then(
				() => {
					if (settled) return
					settled = true
					options.signal?.removeEventListener('abort', onAbort)
					resolve()
				},
				() => {
					if (settled) return
					settled = true
					options.signal?.removeEventListener('abort', onAbort)
					resolve()
				},
			)
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
				firstTokenAt ??= Date.now()
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
