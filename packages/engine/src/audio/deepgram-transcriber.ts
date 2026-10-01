import { EventEmitter } from 'node:events'

import { config } from '#engine/config.js'
import { createLogger } from '#engine/logger.js'

import { asrEncoding, asrSampleRate } from '../shared/audio-format.js'
import { safeInvoke, withTimeout } from '../shared/async-utils.js'
import { monotonicClock } from '../shared/clock.js'
import { latestWinsQueue } from '../shared/task.js'
import { fluxEventSchema, parseWebSocketJsonWithSchema, type WebSocketRawData } from './transport-schemas.js'
import type { CallerTurnEvent } from './types.js'
import { awaitWebSocketOpen, createDefaultWebSocket } from './ws-utils.js'

const log = createLogger('mimic:flux')

export type CreateDeepgramWebSocket = (url: string, options: { headers: Record<string, string> }) => WebSocket

export interface DeepgramTranscriberConfig {
	encoding?: 'linear16' | 'mulaw'
	sampleRate?: number
	createWebSocket?: CreateDeepgramWebSocket
}

export interface FluxConfigureOptions {
	keyterms?: string[]
	eotThreshold?: number
	eagerEotThreshold?: number
	eotTimeoutMs?: number
}

type TranscriberEvents = {
	turnComplete: [transcript: string, confidence: number]
	turnStart: [transcript: string, confidence: number]
	eagerTurn: [transcript: string, confidence: number]
	turnResumed: [transcript: string]
	update: [transcript: string, confidence: number]
	error: [message: string]
	// Union-typed caller turn event. Fires alongside the per-event emissions
	// above so consumers can subscribe to a single channel instead of all five.
	callerTurn: [event: CallerTurnEvent]
}

interface Lifecycle {
	isClosing: boolean
	/** A reconnect attempt is scheduled or in flight. */
	reconnecting: boolean
	/** Consecutive failed reconnects since the last healthy connection. */
	reconnectAttempts: number
	/** Re-applied after a reconnect so keyterms and thresholds survive the drop. */
	latestConfigureOptions: FluxConfigureOptions | null
}

/** Exponential backoff: 500, 1000, 2000, … capped at `maxBackoffMs`. */
export function reconnectBackoffMs(previousAttempts: number) {
	const { initialBackoffMs, maxBackoffMs } = config.mimic.flux.reconnect
	return Math.min(initialBackoffMs * 2 ** previousAttempts, maxBackoffMs)
}

export function createDeepgramTranscriber(opts?: DeepgramTranscriberConfig) {
	const encoding = opts?.encoding ?? asrEncoding
	const sampleRate = opts?.sampleRate ?? asrSampleRate
	const createConn = opts?.createWebSocket ?? createDefaultWebSocket
	const emitter = new EventEmitter<TranscriberEvents>()
	const { maxAttempts: maxReconnectAttempts } = config.mimic.flux.reconnect

	const lifecycle: Lifecycle = {
		isClosing: false,
		reconnecting: false,
		reconnectAttempts: 0,
		latestConfigureOptions: null,
	}

	let socket: WebSocket | null = null
	let closeResolve: (() => void) | null = null
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null

	let audioBuffer: Buffer[] = []
	let bufferedBytes = 0
	const chunkTargetMs = config.mimic.flux.audioChunkTargetMs
	const bytesPerSample = encoding === 'linear16' ? 2 : 1
	const bytesPerChunk = Math.max(1, Math.floor((sampleRate * bytesPerSample * chunkTargetMs) / 1000))

	// Backpressure: cap bytes queued on the socket itself. If Deepgram or
	// the TCP stack stalls, `bufferedAmount` balloons and we will drop the
	// newest caller audio rather than grow unbounded. We allow 8s worth.
	const socketBackpressureLimitBytes = sampleRate * bytesPerSample * 8
	let droppedBytesSinceLastLog = 0
	let lastDropLogAt = 0

	function clearReconnectTimer() {
		clearTimeout(reconnectTimer ?? undefined)
		reconnectTimer = null
	}

	function resolveCloseWaiter() {
		closeResolve?.()
		closeResolve = null
	}

	let resolveConfigureAck: (() => void) | null = null
	let rejectConfigureAck: ((err: Error) => void) | null = null

	function clearConfigureAck() {
		resolveConfigureAck = null
		rejectConfigureAck = null
	}

	function beginConfigureAwait() {
		return new Promise<void>((resolve, reject) => {
			resolveConfigureAck = resolve
			rejectConfigureAck = reject
		})
	}

	function settleConfigureSuccess() {
		resolveConfigureAck?.()
		clearConfigureAck()
	}

	function settleConfigureFailure(message: string) {
		rejectConfigureAck?.(new Error(message))
		clearConfigureAck()
	}

	function buildConfigureMessage(options: FluxConfigureOptions) {
		const msg: Record<string, unknown> = { type: 'Configure' }
		if (options.keyterms !== undefined) {
			msg.keyterms = options.keyterms.slice(0, 100)
		}
		const thresholds: Record<string, unknown> = {}
		if (options.eotThreshold !== undefined) thresholds.eot_threshold = options.eotThreshold
		if (options.eagerEotThreshold !== undefined) thresholds.eager_eot_threshold = options.eagerEotThreshold
		if (options.eotTimeoutMs !== undefined) thresholds.eot_timeout_ms = options.eotTimeoutMs
		if (Object.keys(thresholds).length > 0) msg.thresholds = thresholds
		return msg
	}

	async function dispatchConfigure(options: FluxConfigureOptions) {
		if (!socket || socket.readyState !== WebSocket.OPEN) return
		const activeSocket = socket
		activeSocket.send(JSON.stringify(buildConfigureMessage(options)))
		try {
			await withTimeout(beginConfigureAwait(), config.mimic.timeouts.transcriberConfigureAckMs, {
				message: 'deepgram configure timed out',
				onTimeout: clearConfigureAck,
			})
		} catch (err) {
			log.info({ err }, 'configure request did not settle')
		}
	}

	const enqueueConfigureLatest = latestWinsQueue<FluxConfigureOptions, void>(async (options) => {
		try {
			await dispatchConfigure(options)
		} catch (err) {
			log.error({ err }, 'configure dispatch failed')
		}
	})

	function buildUrl() {
		const { flux } = config.mimic
		const params = new URLSearchParams({
			model: flux.model,
			encoding,
			sample_rate: String(sampleRate),
			eot_threshold: String(flux.eotThreshold),
			eager_eot_threshold: String(flux.eagerEotThreshold),
			eot_timeout_ms: String(flux.eotTimeoutMs),
		})
		return `wss://api.deepgram.com/v2/listen?${params}`
	}

	function parseFluxMessage(raw: WebSocketRawData) {
		const parsedResult = parseWebSocketJsonWithSchema(raw, fluxEventSchema)
		if (!parsedResult.ok) {
			if (parsedResult.reason === 'invalid_shape') {
				log.warn({ rawPreview: parsedResult.text.slice(0, 200) }, 'unexpected WebSocket payload shape')
				return null
			}
			log.error({ err: parsedResult.error, rawPreview: parsedResult.text.slice(0, 200) }, 'failed to parse message')
			return null
		}
		return parsedResult.data
	}

	function closeSocketAfterFatalProtocolError() {
		if (!socket || socket.readyState !== WebSocket.OPEN) return
		const failingSocket = socket
		safeInvoke(
			() => failingSocket.close(),
			(err) => log.info({ err }, 'socket.close after fatal Error failed'),
		)
	}

	function handleFatalFluxError(data: { code?: unknown; description?: string; message?: string }) {
		const detail = data.description ?? data.message ?? 'Unknown Deepgram error'
		log.error({ code: data.code, detail }, 'fatal error')
		emitter.emit('error', detail)
		emitter.emit('callerTurn', { type: 'error', message: detail })
		closeSocketAfterFatalProtocolError()
	}

	function handleConfigureSuccess(data: { thresholds?: Record<string, unknown> }) {
		log.info({ thresholds: data.thresholds ?? {} }, 'configure applied')
		settleConfigureSuccess()
	}

	function handleConfigureFailure(data: { description?: string; message?: string }) {
		const detail = data.description ?? data.message ?? 'unknown'
		log.error({ description: detail }, 'configure failed')
		const message = `Deepgram configure failed: ${detail}`
		settleConfigureFailure(message)
		emitter.emit('error', message)
		emitter.emit('callerTurn', { type: 'error', message })
	}

	function emitTurnInfoEvent(data: {
		event?: string
		turn_index?: number
		transcript?: string
		end_of_turn_confidence?: number
	}) {
		if (!data.event) {
			log.debug({ turn: data.turn_index }, 'TurnInfo without event name')
			return
		}
		const transcript = data.transcript?.trim() ?? ''
		const confidence = data.end_of_turn_confidence ?? 0
		switch (data.event) {
			case 'Update':
				emitter.emit('update', transcript, confidence)
				emitter.emit('callerTurn', { type: 'update', transcript, confidence })
				return
			case 'StartOfTurn':
				log.info(
					{
						turnIndex: data.turn_index,
						transcriptPreview: data.transcript?.slice(0, 40) ?? '',
					},
					'StartOfTurn',
				)
				emitter.emit('turnStart', transcript, confidence)
				emitter.emit('callerTurn', { type: 'turn_start', transcript, confidence })
				return
			case 'EagerEndOfTurn':
				log.info(
					{
						turnIndex: data.turn_index,
						confidence: data.end_of_turn_confidence,
						transcriptPreview: data.transcript?.slice(0, 60),
					},
					'EagerEndOfTurn',
				)
				if (transcript) {
					emitter.emit('eagerTurn', transcript, confidence)
					emitter.emit('callerTurn', { type: 'eager_turn', transcript, confidence })
				}
				return
			case 'TurnResumed':
				log.info(
					{
						turnIndex: data.turn_index,
						transcriptPreview: data.transcript?.slice(0, 60) ?? '',
					},
					'TurnResumed',
				)
				emitter.emit('turnResumed', transcript)
				emitter.emit('callerTurn', { type: 'turn_resumed', transcript })
				return
			case 'EndOfTurn':
				log.info(
					{
						turnIndex: data.turn_index,
						confidence: data.end_of_turn_confidence,
						transcriptPreview: data.transcript?.slice(0, 60),
					},
					'EndOfTurn',
				)
				if (transcript) {
					emitter.emit('turnComplete', transcript, confidence)
					emitter.emit('callerTurn', { type: 'turn_complete', transcript, confidence })
				}
				return
			default:
				log.debug({ event: data.event, turnIndex: data.turn_index }, 'unknown Flux event')
		}
	}

	function handleFluxMessage(raw: WebSocketRawData) {
		const data = parseFluxMessage(raw)
		if (!data) return
		if (data.type === 'Error') return handleFatalFluxError(data)
		if (data.type === 'ConfigureSuccess') return handleConfigureSuccess(data)
		if (data.type === 'ConfigureFailure') return handleConfigureFailure(data)
		if (data.type !== 'TurnInfo') {
			log.debug({ type: data.type }, 'unhandled Flux message type')
			return
		}
		emitTurnInfoEvent(data)
	}

	function wireSocket(ws: WebSocket) {
		const onMessage = (event: MessageEvent) => handleFluxMessage(event.data as WebSocketRawData)
		const onClose = (event: CloseEvent) => {
			const code = event.code
			const reasonStr = event.reason || 'unknown'
			log.info({ code, reason: reasonStr }, 'connection closed')
			ws.removeEventListener('message', onMessage)
			ws.removeEventListener('close', onClose)
			if (socket === ws) {
				socket = null
				// Drop any unsent coalesced caller audio. Reusing this data after
				// reconnect can splice stale pre-drop audio into the new stream.
				resetBufferedAudio()
			}
			resolveCloseWaiter()
			settleConfigureFailure('Deepgram socket closed before configure ack')
			if (!lifecycle.isClosing && code !== 1000) return attemptReconnect()
			lifecycle.isClosing = false
		}
		ws.addEventListener('message', onMessage)
		ws.addEventListener('close', onClose)
	}

	function closeReconnectSocket(ws: WebSocket, context: string) {
		safeInvoke(
			() => ws.close(),
			(closeErr) => log.info({ err: closeErr }, context),
		)
	}

	function applyReconnectSuccess(ws: WebSocket) {
		// Ensure reconnection starts with a clean coalescing buffer.
		resetBufferedAudio()
		socket = ws
		lifecycle.reconnecting = false
		lifecycle.reconnectAttempts = 0
		log.info('reconnected successfully')
		if (lifecycle.latestConfigureOptions) {
			enqueueConfigureLatest(lifecycle.latestConfigureOptions)
		}
	}

	function buildHeaders() {
		return { Authorization: `Token ${config.mimic.deepgram.apiKey}` }
	}

	function createDeepgramSocket() {
		return createConn(buildUrl(), { headers: buildHeaders() })
	}

	async function runReconnectAttempt() {
		if (lifecycle.isClosing) {
			lifecycle.reconnecting = false
			return
		}
		let ws: WebSocket | null = null
		try {
			ws = createDeepgramSocket()
			wireSocket(ws)
			await awaitWebSocketOpen(ws, (err) => {
				log.error({ err }, 'WebSocket error during reconnect')
			})
			if (lifecycle.isClosing) {
				closeReconnectSocket(ws, 'reconnect socket.close failed after shutdown')
				lifecycle.reconnecting = false
				return
			}
			applyReconnectSuccess(ws)
		} catch (err) {
			if (ws) closeReconnectSocket(ws, 'reconnect socket.close failed')
			lifecycle.reconnecting = false
			log.error({ err, attempt: lifecycle.reconnectAttempts }, 'reconnect attempt failed')
			attemptReconnect()
		}
	}

	function attemptReconnect() {
		if (lifecycle.isClosing || lifecycle.reconnecting) return
		if (lifecycle.reconnectAttempts >= maxReconnectAttempts) {
			log.error({ attempts: lifecycle.reconnectAttempts }, 'reconnection failed after max attempts')
			emitter.emit('error', 'Deepgram reconnection failed after max attempts')
			return
		}
		const backoffMs = reconnectBackoffMs(lifecycle.reconnectAttempts)
		lifecycle.reconnecting = true
		lifecycle.reconnectAttempts += 1
		log.info({ attempt: lifecycle.reconnectAttempts, backoffMs }, 'reconnecting')
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null
			void runReconnectAttempt()
		}, backoffMs)
	}

	function resetBufferedAudio() {
		audioBuffer = []
		bufferedBytes = 0
	}

	function connectSocket() {
		const ws = createDeepgramSocket()
		socket = ws
		wireSocket(ws)
		return ws
	}

	let connectPromise: Promise<void> | null = null

	function connect() {
		if (connectPromise) return connectPromise
		if (socket) return Promise.resolve()
		lifecycle.isClosing = false
		lifecycle.reconnecting = false
		lifecycle.reconnectAttempts = 0
		clearReconnectTimer()
		resetBufferedAudio()
		const thisSocket = connectSocket()

		connectPromise = awaitWebSocketOpen(thisSocket, (err) => {
			log.error({ err }, 'WebSocket error')
			emitter.emit('error', 'Deepgram WebSocket error')
			emitter.emit('callerTurn', { type: 'error', message: 'Deepgram WebSocket error' })
		})
			.catch((err) => {
				if (socket === thisSocket) socket = null
				safeInvoke(
					() => thisSocket.close(),
					(closeErr) => log.info({ err: closeErr }, 'socket.close during connect failure'),
				)
				throw err
			})
			.finally(() => {
				connectPromise = null
			})
		return connectPromise
	}

	function configure(options: FluxConfigureOptions) {
		// Merge rather than replace: keyterms and endpointing thresholds are
		// configured by different parts of the engine, and the latest-wins
		// queue plus reconnect replay would otherwise drop whichever came first.
		const merged: FluxConfigureOptions = { ...(lifecycle.latestConfigureOptions ?? {}), ...options }
		lifecycle.latestConfigureOptions = merged
		if (!socket || socket.readyState !== WebSocket.OPEN) return
		enqueueConfigureLatest(merged)
	}

	function sendAudio(audioBytes: Buffer) {
		if (lifecycle.isClosing || !socket || socket.readyState !== WebSocket.OPEN) return

		// Guard against socket-level backpressure: if the ws library is
		// holding unsent bytes, stop queuing more audio so memory stays bounded.
		if (socket.bufferedAmount > socketBackpressureLimitBytes) {
			droppedBytesSinceLastLog += audioBytes.length
			const now = monotonicClock.now()
			if (now - lastDropLogAt >= 1_000) {
				log.warn(
					{ bufferedAmount: socket.bufferedAmount, droppedBytes: droppedBytesSinceLastLog },
					'deepgram socket backpressure; dropping caller audio',
				)
				lastDropLogAt = now
				droppedBytesSinceLastLog = 0
			}
			return
		}

		audioBuffer.push(audioBytes)
		bufferedBytes += audioBytes.length

		if (bufferedBytes >= bytesPerChunk) {
			const combined = Buffer.concat(audioBuffer)
			audioBuffer = []
			bufferedBytes = 0
			socket.send(combined)
		}
	}

	function flushAudio() {
		if (!socket || socket.readyState !== WebSocket.OPEN) return
		if (audioBuffer.length > 0) {
			socket.send(Buffer.concat(audioBuffer))
			resetBufferedAudio()
		}
	}

	function requestCloseStream() {
		if (!socket || socket.readyState !== WebSocket.OPEN) return false
		socket.send(JSON.stringify({ type: 'CloseStream' }))
		return true
	}

	async function awaitCloseHandshake() {
		await withTimeout(
			new Promise<void>((resolve) => {
				closeResolve = resolve
			}),
			config.mimic.timeouts.transcriberCloseHandshakeMs,
			{
				message: 'deepgram close handshake timed out',
				onTimeout: () => {
					closeResolve = null
				},
			},
		).catch((err) => {
			log.info({ err }, 'close handshake timed out; forcing socket close')
		})
	}

	function closeSocketIfPresent() {
		if (!socket) return
		const activeSocket = socket
		safeInvoke(
			() => activeSocket.close(),
			(err) => log.info({ err }, 'socket.close during teardown (expected if not yet open)'),
		)
		socket = null
	}

	let closePromise: Promise<void> | null = null

	function close() {
		if (closePromise) return closePromise
		closePromise = (async () => {
			lifecycle.isClosing = true
			lifecycle.reconnecting = false
			settleConfigureFailure('Deepgram transcriber closed')
			clearReconnectTimer()
			flushAudio()
			if (requestCloseStream()) await awaitCloseHandshake()
			closeSocketIfPresent()
		})()
		return closePromise
	}

	return {
		connect,
		configure,
		sendAudio,
		on: emitter.on.bind(emitter) as typeof emitter.on,
		off: emitter.off.bind(emitter) as typeof emitter.off,
		removeAllListeners: () => emitter.removeAllListeners(),
		close,
	}
}
