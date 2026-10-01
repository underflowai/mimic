/**
 * Cartesia Text-to-Speech speaker.
 *
 * Pure synthesis executor — delegates WebSocket lifecycle to a
 * TtsSocketSession. This module sends text to Cartesia using
 * contexts with continuations and parses the streamed response.
 *
 * Each turn gets its own `context_id`. Text deltas are sent with
 * `continue: true`; the final signal is an empty transcript with
 * `continue: false`. Cartesia streams `chunk` events back with
 * base64-encoded PCM, interleaved with `timestamps` events carrying
 * word-level timing, ending with a `done` event.
 *
 * PCM is emitted exactly as Cartesia delivers it; the pipeline's
 * frame-align stage owns re-chunking and the end-of-stream fade.
 *
 * We use custom buffering (`max_buffer_delay_ms: 0`) because
 * upstream sentence-chunking already batches at phrase boundaries.
 */

import { randomUUID } from 'node:crypto'

import { config } from '#engine/config.js'
import { createLogger } from '#engine/logger.js'

import { ttsSampleRate } from '../shared/audio-format.js'
import type { WordTiming } from '../shared/audio-pacing.js'
import { safeInvoke } from '../shared/async-utils.js'
import {
	cartesiaResponseSchema,
	parseWebSocketJsonWithSchema,
	type CartesiaTimestamps,
	type WebSocketRawData,
} from './transport-schemas.js'
import { createTtsSocketSession, type CreateWebSocket, type TtsSocketSession } from './tts-session.js'
import { createDefaultWebSocket } from './ws-utils.js'

const log = createLogger('mimic:tts')

export interface TtsSynthesisListener {
	/** Raw PCM16 at `ttsSampleRate`, in whatever block sizes Cartesia emits. */
	onAudioChunk: (chunk: Buffer) => void
	/** Word timings for the audio generated so far, relative to the start of this synthesis. */
	onWordTimings?: (words: WordTiming[]) => void
}

export interface TtsSynthesisHandle {
	pushTextDelta(delta: string): void
	triggerSynthesisStart(): void
	audioComplete: Promise<void>
}

export interface CreateTtsSpeakerOptions {
	createWebSocket?: CreateWebSocket
	voiceId?: string
	session?: TtsSocketSession
}

function toWordTimings(msg: CartesiaTimestamps): WordTiming[] {
	const { words, start, end } = msg.word_timestamps
	const count = Math.min(words.length, start.length, end.length)
	const timings: WordTiming[] = []
	for (let i = 0; i < count; i++) {
		timings.push({ word: words[i], startMs: start[i] * 1000, endMs: end[i] * 1000 })
	}
	return timings
}

export function createTtsSpeaker(options: CreateTtsSpeakerOptions = {}) {
	const createConn = options.createWebSocket ?? createDefaultWebSocket
	const voiceId = options.voiceId ?? 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4'
	const watchdogMs = config.mimic.timeouts.ttsSynthesisWatchdogMs

	const session =
		options.session ??
		createTtsSocketSession({
			buildUrl: () => `wss://api.cartesia.ai/tts/websocket?cartesia_version=${config.mimic.cartesia.apiVersion}`,
			buildHeaders: () => ({ 'X-API-Key': config.mimic.cartesia.apiKey }),
			createWebSocket: createConn,
		})

	let synthesisEpoch = 0
	let connectPromise: Promise<void> | null = null
	let closed = false

	function connect() {
		if (!connectPromise) {
			connectPromise = session
				.connect()
				.then(() => {})
				.catch((err) => {
					connectPromise = null
					throw err
				})
		}
		return connectPromise
	}

	function buildGenerationMessage(contextId: string, transcript: string, isContinuation: boolean) {
		return {
			model_id: config.mimic.cartesia.ttsModel,
			transcript,
			voice: { mode: 'id', id: voiceId },
			output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: ttsSampleRate },
			language: 'en',
			context_id: contextId,
			continue: isContinuation,
			max_buffer_delay_ms: 0,
			add_timestamps: true,
		}
	}

	function sendJson(ws: WebSocket, payload: unknown, context: string) {
		try {
			ws.send(JSON.stringify(payload))
			return true
		} catch (err) {
			log.error({ err, context }, 'failed to send TTS WebSocket frame')
			return false
		}
	}

	// ── Core synthesis ───────────────────────────────────────────────────

	/**
	 * Listens for Cartesia events scoped to `contextId`. Audio chunks are
	 * base64-decoded and handed to the listener as-is; `timestamps` events
	 * are converted to `WordTiming`s. Resolves when `done` arrives; rejects
	 * on error or watchdog timeout.
	 */
	function synthesizeOnSocket(ws: WebSocket, contextId: string, listener: TtsSynthesisListener) {
		let settled = false
		let failSynthesis: ((err: Error) => void) | null = null

		const deliver = (what: string, fn: () => void) => {
			safeInvoke(fn, (callbackErr) => {
				failSynthesis?.(new Error(`TTS ${what} callback failed: ${callbackErr.message}`))
				log.error({ err: callbackErr }, `${what} callback threw`)
			})
		}

		const promise = new Promise<void>((resolve, reject) => {
			let watchdog: ReturnType<typeof setTimeout> | null = null
			const cleanup = () => {
				if (watchdog) {
					clearTimeout(watchdog)
					watchdog = null
				}
				ws.removeEventListener('message', onMessage)
				ws.removeEventListener('close', onClose)
			}
			const resetWatchdog = () => {
				if (watchdog) clearTimeout(watchdog)
				watchdog = setTimeout(() => {
					fail(new Error(`Cartesia TTS synthesis timed out after ${watchdogMs}ms`))
				}, watchdogMs)
			}

			const finish = () => {
				if (settled) return
				settled = true
				cleanup()
				resolve()
			}

			const fail = (err: Error) => {
				if (settled) return
				settled = true
				cleanup()
				reject(err)
			}
			failSynthesis = fail

			// An interrupt cancels quietly: the pipeline is already being torn down.
			session.markSynthesisStart(contextId, finish)

			function onClose(event: CloseEvent) {
				if (settled) return
				log.error({ code: event.code }, 'WebSocket closed mid-utterance')
				fail(new Error(`Cartesia TTS WebSocket closed unexpectedly (code ${event.code})`))
			}

			function onMessage(event: MessageEvent) {
				if (settled) return
				resetWatchdog()
				const parsed = parseWebSocketJsonWithSchema(event.data as WebSocketRawData, cartesiaResponseSchema)
				if (!parsed.ok) {
					if (parsed.reason === 'invalid_json') {
						log.error({ err: parsed.error, preview: parsed.text.slice(0, 200) }, 'invalid JSON from Cartesia TTS')
						fail(new Error('Cartesia TTS sent invalid JSON'))
						return
					}
					log.warn({ preview: parsed.text.slice(0, 200) }, 'unexpected TTS WebSocket payload shape')
					return
				}
				const msg = parsed.data
				if ('context_id' in msg && msg.context_id !== contextId) return

				switch (msg.type) {
					case 'error': {
						const errMsg = msg.message ?? msg.error ?? msg.title ?? 'unknown error'
						log.error({ msg: errMsg }, 'Cartesia TTS error')
						fail(new Error(`Cartesia TTS: ${errMsg}`))
						return
					}
					case 'chunk': {
						let decoded: Buffer
						try {
							decoded = Buffer.from(msg.data, 'base64')
						} catch (err) {
							log.error({ err }, 'failed to decode audio chunk')
							fail(new Error('Cartesia TTS audio chunk decode failed'))
							return
						}
						if (decoded.length > 0) deliver('audio', () => listener.onAudioChunk(decoded))
						return
					}
					case 'timestamps': {
						if (!listener.onWordTimings) return
						const timings = toWordTimings(msg)
						if (timings.length > 0) deliver('word timing', () => listener.onWordTimings!(timings))
						return
					}
					case 'done':
						finish()
						return
					case 'flush_done':
						return
				}
			}

			ws.addEventListener('message', onMessage)
			ws.addEventListener('close', onClose)
			resetWatchdog()
		})
		promise.catch(() => {})

		return promise
	}

	// ── Public synthesis API ─────────────────────────────────────────────

	const noopHandle: TtsSynthesisHandle = {
		pushTextDelta() {},
		triggerSynthesisStart() {},
		audioComplete: Promise.resolve(),
	}

	async function preSendTextForSynthesis(text: string, listener: TtsSynthesisListener): Promise<TtsSynthesisHandle> {
		const trimmed = text.trim()
		if (!trimmed) {
			log.warn('skipping empty pre-send')
			return noopHandle
		}
		const myEpoch = ++synthesisEpoch
		session.interrupt()

		const ws = await session.acquireSocket()
		if (myEpoch !== synthesisEpoch) {
			log.info('pre-send aborted during socket acquisition (stale epoch)')
			return noopHandle
		}
		if (ws.readyState !== WebSocket.OPEN) {
			throw new Error('Socket closed before pre-send could begin')
		}

		const contextId = `turn-${randomUUID()}`
		const synthesis = synthesizeOnSocket(ws, contextId, listener)

		if (!sendJson(ws, buildGenerationMessage(contextId, trimmed, true), 'preSendText:first')) {
			throw new Error('failed to send first text chunk')
		}

		if (myEpoch !== synthesisEpoch) {
			log.info({ contextId }, 'pre-send aborted after first send (stale epoch)')
			return noopHandle
		}

		let doneSent = false

		const audioComplete = synthesis.finally(() => {
			session.markSynthesisEnd()
		})

		return {
			pushTextDelta(delta: string) {
				if (doneSent || ws.readyState !== WebSocket.OPEN) return
				if (!sendJson(ws, buildGenerationMessage(contextId, delta, true), 'pushTextDelta')) {
					interrupt()
				}
			},

			triggerSynthesisStart() {
				if (doneSent || ws.readyState !== WebSocket.OPEN) return
				doneSent = true
				if (!sendJson(ws, buildGenerationMessage(contextId, '', false), 'triggerSynthesisStart')) {
					interrupt()
				}
			},

			audioComplete,
		}
	}

	function interrupt() {
		synthesisEpoch++
		session.interrupt()
	}

	function close() {
		if (closed) return
		closed = true
		synthesisEpoch++
		session.shutdown()
	}

	return { connect, preSendTextForSynthesis, interrupt, close }
}

export type TtsSpeaker = ReturnType<typeof createTtsSpeaker>
