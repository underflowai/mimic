/**
 * In-process WebSocket stand-in for unit tests.
 *
 * Extends `EventTarget` and dispatches real `Event`/`MessageEvent`/
 * `CloseEvent`/`ErrorEvent` objects so consumers that use the DOM-style
 * `addEventListener` API (as the production transcriber/TTS code now does)
 * see exactly what the real runtime would deliver.
 */

export class AutoOpenMockSocket extends EventTarget {
	readyState: number = WebSocket.CONNECTING
	binaryType: 'arraybuffer' | 'blob' = 'arraybuffer'
	private closed = false

	constructor(options?: { openDelayMs?: number; autoOpen?: boolean }) {
		super()
		if (options?.autoOpen === false) return
		const openDelayMs = options?.openDelayMs ?? 0
		const openSocket = () => {
			if (this.closed) return
			this.readyState = WebSocket.OPEN
			this.dispatchEvent(new Event('open'))
		}
		if (openDelayMs > 0) {
			setTimeout(openSocket, openDelayMs)
			return
		}
		queueMicrotask(openSocket)
	}

	protected get isClosed() {
		return this.closed
	}

	protected get isOpen() {
		return !this.closed && this.readyState === WebSocket.OPEN
	}

	protected emitJsonMessage(payload: unknown) {
		if (this.closed) return
		const bytes = Buffer.from(JSON.stringify(payload))
		// Match what the real runtime delivers when binaryType='arraybuffer':
		// a standalone ArrayBuffer view with no shared pool backing.
		const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
		this.dispatchEvent(new MessageEvent('message', { data: arrayBuffer }))
	}

	protected emitErrorEvent(err: Error) {
		// `ErrorEvent` is not declared globally in `@types/node`, so build a
		// plain `Event` and attach the fields that `extractWebSocketError`
		// reads structurally.
		const event = Object.assign(new Event('error'), { error: err, message: err.message })
		this.dispatchEvent(event)
	}

	close(code = 1000, reason: string = '') {
		if (this.closed) return
		this.closed = true
		this.readyState = WebSocket.CLOSED
		this.dispatchEvent(new CloseEvent('close', { code, reason }))
	}
}
