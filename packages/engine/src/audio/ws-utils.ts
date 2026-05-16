/**
 * Helpers for working with Node's native (undici-backed) WebSocket global.
 *
 * The codebase standardizes on `binaryType = 'arraybuffer'` so incoming
 * binary frames arrive synchronously as ArrayBuffers rather than Blobs.
 *
 * ─── Note on the `NodeWebSocket` alias below ──────────────────────────
 * At Node runtime the global `WebSocket` IS undici's implementation, whose
 * constructor accepts the extended init `{ headers, protocols, dispatcher }`
 * on top of `string | string[]`. `@types/node` types this correctly only
 * when DOM lib is NOT loaded. Consumers like `apps/web` include
 * `"lib": ["DOM", ...]` for client bundles, and because `libs/core` exports
 * source `.ts` (not `.d.ts`) via its package.json, TS ends up re-typing this
 * file under DOM lib where the constructor only accepts `(url, protocols?)`.
 * This file only ever runs in Node, so we alias the constructor to the
 * true runtime shape once, at the module top, and use that for construction.
 */

type NodeWebSocketInit = string | string[] | { headers?: Record<string, string>; protocols?: string | string[] }
type NodeWebSocketConstructor = new (url: string | URL, init?: NodeWebSocketInit) => WebSocket
const NodeWebSocket = WebSocket as unknown as NodeWebSocketConstructor

export function createDefaultWebSocket(url: string, options: { headers: Record<string, string> }): WebSocket {
	const ws = new NodeWebSocket(url, { headers: options.headers })
	ws.binaryType = 'arraybuffer'
	return ws
}

/**
 * Normalize the various shapes the `error` event can carry (undici attaches
 * `error` and `message` to the ErrorEvent at runtime) down to a regular
 * `Error`. We read fields structurally instead of referencing the
 * `ErrorEvent` type because `@types/node` does not declare `ErrorEvent` as
 * a global, even though Node exposes it at runtime.
 */
export function extractWebSocketError(event: Event): Error {
	const errorLike = event as Event & { error?: unknown; message?: string }
	if (errorLike.error instanceof Error) return errorLike.error
	if (typeof errorLike.message === 'string' && errorLike.message.length > 0) {
		return new Error(errorLike.message)
	}
	return new Error('unknown WebSocket error')
}

/**
 * Await a WebSocket `open` event with correct early-error cleanup.
 * On success, replaces the one-shot error handler with `onPersistentError`.
 * Rejects if the socket does not open within `timeoutMs` or closes before opening.
 */
export function awaitWebSocketOpen(ws: WebSocket, onPersistentError: (err: Error) => void, timeoutMs = 10_000) {
	return new Promise<void>((resolve, reject) => {
		let settled = false
		const cleanup = () => {
			settled = true
			clearTimeout(timer)
			ws.removeEventListener('error', onEarlyError)
			ws.removeEventListener('close', onEarlyClose)
			ws.removeEventListener('open', onOpen)
		}
		const onEarlyError = (event: Event) => {
			if (settled) return
			const err = extractWebSocketError(event)
			cleanup()
			reject(err)
		}
		const onEarlyClose = (event: Event) => {
			if (settled) return
			const code = (event as CloseEvent).code
			cleanup()
			reject(new Error(`WebSocket closed before open (code ${code})`))
		}
		const onOpen = () => {
			if (settled) return
			cleanup()
			ws.addEventListener('error', (event: Event) => {
				// Per the WHATWG WebSocket spec (section "Feedback from the
				// protocol", and RFC 6455 §7.1.4), when the underlying
				// transport closes without a peer close-frame, the UA must
				// fire an `error` event followed by a `close` event with
				// code 1006. Undici implements this in
				// `WebSocket.#onSocketClose`: it sets readyState to CLOSED,
				// then dispatches an ErrorEvent carrying `new TypeError('')`
				// (empty reason), then dispatches the CloseEvent. See
				// undici's `lib/web/websocket/websocket.js::#onSocketClose`.
				//
				// In our codebase the error fires any time the TCP/TLS layer
				// drops before the server's close frame arrives — which is
				// exactly what happens on `interrupt()` when we close the
				// primary TTS socket under load. It is redundant with the
				// `close` event we already handle (close code carries the
				// signal). Suppress it to keep logs actionable. Real errors
				// on a live connection fire while readyState is still OPEN.
				if (ws.readyState !== WebSocket.OPEN) return
				onPersistentError(extractWebSocketError(event))
			})
			resolve()
		}
		const timer = setTimeout(() => {
			if (settled) return
			cleanup()
			reject(new Error(`WebSocket did not open within ${timeoutMs}ms`))
		}, timeoutMs)
		ws.addEventListener('error', onEarlyError, { once: true })
		ws.addEventListener('close', onEarlyClose, { once: true })
		ws.addEventListener('open', onOpen, { once: true })
	})
}
