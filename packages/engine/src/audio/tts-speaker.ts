/**
 * Cartesia Text-to-Speech speaker.
 *
 * Pure synthesis executor — delegates WebSocket lifecycle to a
 * TtsSocketSession. This module sends text to Cartesia using
 * contexts with continuations and parses the streamed PCM response.
 *
 * Each turn gets its own `context_id`. Text deltas are sent with
 * `continue: true`; the final signal is an empty transcript with
 * `continue: false`. Cartesia streams `chunk` events back with
 * base64-encoded PCM, ending with a `done` event.
 *
 * We use custom buffering (`max_buffer_delay_ms: 0`) because
 * upstream sentence-chunking already batches at phrase boundaries.
 */

import { config } from '#engine/config.js'
import { createLogger } from '#engine/logger.js'
import { randomUUID } from 'node:crypto'

import { safeInvoke } from '../shared/async-utils.js'
import { applyLinearFade, ttsFrameBytes } from '../shared/audio-pacing.js'
import { cartesiaResponseSchema, parseWebSocketJsonWithSchema, type WebSocketRawData } from './transport-schemas.js'
import { createTtsSocketSession, type CreateWebSocket, type TtsSocketSession } from './tts-session.js'
import { createDefaultWebSocket } from './ws-utils.js'

const log = createLogger('mimic:tts')

type AudioChunkCallback = (chunk: Buffer) => void

const ttsFadeMs = 10
const maxBufferedPcmBytes = 5 * 1024 * 1024
const synthesisWatchdogMs = 12_000

export interface CreateTtsSpeakerOptions {
	createWebSocket?: CreateWebSocket
	voiceId?: string
	session?: TtsSocketSession
}

export function createTtsSpeaker(options: CreateTtsSpeakerOptions = {}) {
	const createConn = options.createWebSocket ?? createDefaultWebSocket
	const voiceId = options.voiceId ?? 'f786b574-daa5-4673-aa0c-cbe3e8534c02'

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
			output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 48000 },
			language: 'en',
			context_id: contextId,
			continue: isContinuation,
			max_buffer_delay_ms: 0,
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
	 * Listens for Cartesia chunk/done/error events scoped to `contextId`.
	 * Audio chunks arrive as base64, are decoded, frame-aligned, and
	 * emitted via `onAudioChunk`. Resolves when `done` arrives; rejects
	 * on error or watchdog timeout.
	 */
	function synthesizeOnSocket(ws: WebSocket, contextId: string, onAudioChunk: AudioChunkCallback) {
		const pcmParts: Buffer[] = []
		let pcmLen = 0
		let settled = false
		let failSynthesis: ((err: Error) => void) | null = null

		const concatParts = () => {
			if (pcmParts.length === 0) return Buffer.alloc(0)
			const buf = Buffer.concat(pcmParts)
			pcmParts.length = 0
			pcmLen = 0
			return buf
		}

		const emitChunk = (chunk: Buffer) => {
			let callbackFailed = false
			safeInvoke(
				() => onAudioChunk(chunk),
				(callbackErr) => {
					callbackFailed = true
					failSynthesis?.(new Error(`TTS audio callback failed: ${callbackErr.message}`))
					log.error({ err: callbackErr }, 'onAudioChunk callback threw')
				},
			)
			return !callbackFailed
		}

		const drainFullFrames = () => {
			if (pcmLen < ttsFrameBytes) return
			let pcmBuffer = concatParts()
			while (pcmBuffer.length >= ttsFrameBytes && !settled) {
				const slice = pcmBuffer.subarray(0, ttsFrameBytes)
				pcmBuffer = pcmBuffer.subarray(ttsFrameBytes)
				if (!emitChunk(slice)) return
			}
			if (pcmBuffer.length > 0) {
				pcmParts.push(pcmBuffer)
				pcmLen = pcmBuffer.length
			}
		}

		const drainRemainderWithFade = () => {
			if (settled) return
			const pcmBuffer = concatParts()
			let offset = 0
			while (offset < pcmBuffer.length && !settled) {
				const end = Math.min(offset + ttsFrameBytes, pcmBuffer.length)
				const slice = pcmBuffer.subarray(offset, end)
				const isLast = end >= pcmBuffer.length
				if (!emitChunk(isLast ? applyLinearFade(slice, ttsFadeMs) : slice)) return
				offset = end
			}
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
					fail(new Error(`Cartesia TTS synthesis timed out after ${synthesisWatchdogMs}ms`))
				}, synthesisWatchdogMs)
			}

			const finish = () => {
				if (settled) return
				settled = true
				cleanup()
				resolve()
			}

			const cancel = () => {
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

			session.markSynthesisStart(contextId, cancel)

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

				if (msg.type === 'error') {
					const errMsg = msg.message ?? msg.error ?? msg.title ?? 'unknown error'
					log.error({ msg: errMsg }, 'Cartesia TTS error')
					fail(new Error(`Cartesia TTS: ${errMsg}`))
					return
				}

				if (msg.type === 'chunk') {
					try {
						const decoded = Buffer.from(msg.data, 'base64')
						pcmParts.push(decoded)
						pcmLen += decoded.length
						if (pcmLen > maxBufferedPcmBytes) {
							log.error({ pcmLen }, 'buffered PCM exceeds memory cap, aborting synthesis')
							fail(new Error('Cartesia TTS buffered PCM exceeded memory cap'))
							return
						}
						drainFullFrames()
					} catch (err) {
						log.error({ err }, 'failed to decode audio chunk')
						fail(new Error('Cartesia TTS audio chunk decode failed'))
					}
					return
				}

				if (msg.type === 'flush_done') {
					drainFullFrames()
					return
				}

				if (msg.type === 'done') {
					drainFullFrames()
					drainRemainderWithFade()
					finish()
					return
				}
			}

			ws.addEventListener('message', onMessage)
			ws.addEventListener('close', onClose)
			resetWatchdog()
		})
		promise.catch(() => {})

		return {
			promise,
			cancel() {
				settled = true
			},
		}
	}

	// ── Public synthesis API ─────────────────────────────────────────────

	const noopHandle = { pushTextDelta(_text: string) {}, triggerSynthesisStart() {}, audioComplete: Promise.resolve() }

	async function preSendTextForSynthesis(text: string, onAudioChunk: AudioChunkCallback) {
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
		const synth = synthesizeOnSocket(ws, contextId, onAudioChunk)
		synth.promise.catch(() => {})

		if (!sendJson(ws, buildGenerationMessage(contextId, trimmed, true), 'preSendText:first')) {
			throw new Error('failed to send first text chunk')
		}

		if (myEpoch !== synthesisEpoch) {
			log.info({ contextId }, 'pre-send aborted after first send (stale epoch)')
			return noopHandle
		}

		let doneSent = false

		const audioComplete = synth.promise.finally(() => {
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
