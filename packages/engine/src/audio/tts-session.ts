/**
 * TTS WebSocket Session
 *
 * Owns a single persistent WebSocket to the Cartesia TTS API. Cartesia
 * multiplexes many contexts on one socket, so the Inworld-era
 * primary/secondary socket dance is no longer needed. On interrupt we
 * send a `cancel` message for the active context — the socket stays
 * alive for the next turn.
 *
 * Reconnect is lazy: if the socket drops we re-open on the next
 * `acquireSocket()` call.
 */

import { randomUUID } from 'node:crypto'

import { createLogger } from '#engine/logger.js'

import { safeInvoke } from '../shared/async-utils.js'
import { awaitWebSocketOpen } from './ws-utils.js'

const baseLog = createLogger('mimic:tts-session')

export type CreateWebSocket = (url: string, options: { headers: Record<string, string> }) => WebSocket

export interface TtsSocketSessionOptions {
	buildUrl: () => string
	buildHeaders: () => Record<string, string>
	createWebSocket: CreateWebSocket
}

export function createTtsSocketSession(options: TtsSocketSessionOptions) {
	const sessionId = randomUUID().slice(0, 8)
	const log = baseLog.child({ sessionId })

	let ws: WebSocket | null = null
	let connecting: Promise<WebSocket> | null = null
	let closed = false
	let synthesizing = false
	let activeContextId: string | null = null
	let activeSynthesisAbort: (() => void) | null = null

	function isOpen() {
		return ws?.readyState === WebSocket.OPEN
	}

	async function openSocket(): Promise<WebSocket> {
		const url = options.buildUrl()
		const sock = options.createWebSocket(url, { headers: options.buildHeaders() })
		await awaitWebSocketOpen(sock, (err) => log.error({ err }, 'WebSocket error'))
		sock.addEventListener('close', (event) => {
			log.info({ code: event.code }, 'WebSocket closed')
			if (ws === sock) ws = null
		})
		return sock
	}

	async function connect() {
		if (closed) return
		if (isOpen()) return
		if (connecting) {
			await connecting
			return
		}
		connecting = openSocket()
			.then((sock) => {
				ws = sock
				log.info('Cartesia TTS (WebSocket) ready')
				return sock
			})
			.catch((err) => {
				connecting = null
				throw err
			})
			.finally(() => {
				connecting = null
			})
		await connecting
	}

	async function acquireSocket(): Promise<WebSocket> {
		if (closed) throw new DOMException('TTS session closed', 'AbortError')
		if (isOpen()) return ws!
		await connect()
		if (!isOpen()) throw new Error('WebSocket not open after connect')
		return ws!
	}

	function markSynthesisStart(contextId: string, abort: () => void) {
		synthesizing = true
		activeContextId = contextId
		activeSynthesisAbort = abort
	}

	function markSynthesisEnd() {
		synthesizing = false
		activeContextId = null
		activeSynthesisAbort = null
	}

	function interrupt() {
		if (!synthesizing) return
		activeSynthesisAbort?.()
		if (activeContextId && isOpen()) {
			safeInvoke(
				() => ws!.send(JSON.stringify({ context_id: activeContextId, cancel: true })),
				(err) => log.error({ err }, 'failed to send cancel'),
			)
		}
		markSynthesisEnd()
		log.info('interrupted')
	}

	function shutdown() {
		if (closed) return
		closed = true
		interrupt()
		if (ws) {
			safeInvoke(
				() => ws!.close(),
				(err) => log.error({ err }, 'socket.close failed'),
			)
			ws = null
		}
	}

	return {
		sessionId,
		connect,
		acquireSocket,
		markSynthesisStart,
		markSynthesisEnd,
		interrupt,
		shutdown,
		isIdle: () => !synthesizing,
	}
}

export type TtsSocketSession = ReturnType<typeof createTtsSocketSession>
