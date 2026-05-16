/**
 * In-process WebSocket stand-in for unit tests.
 *
 * Extends `EventTarget` and dispatches real `Event`/`MessageEvent`/
 * `CloseEvent`/`ErrorEvent` objects so consumers that use the DOM-style
 * `addEventListener` API (as the production transcriber/TTS code now does)
 * see exactly what the real runtime would deliver.
 */
export class AutoOpenMockSocket extends EventTarget {
    readyState = WebSocket.CONNECTING;
    binaryType = 'arraybuffer';
    closed = false;
    constructor(options) {
        super();
        if (options?.autoOpen === false)
            return;
        const openDelayMs = options?.openDelayMs ?? 0;
        const openSocket = () => {
            if (this.closed)
                return;
            this.readyState = WebSocket.OPEN;
            this.dispatchEvent(new Event('open'));
        };
        if (openDelayMs > 0) {
            setTimeout(openSocket, openDelayMs);
            return;
        }
        queueMicrotask(openSocket);
    }
    get isClosed() {
        return this.closed;
    }
    get isOpen() {
        return !this.closed && this.readyState === WebSocket.OPEN;
    }
    emitJsonMessage(payload) {
        if (this.closed)
            return;
        const bytes = Buffer.from(JSON.stringify(payload));
        // Match what the real runtime delivers when binaryType='arraybuffer':
        // a standalone ArrayBuffer view with no shared pool backing.
        const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        this.dispatchEvent(new MessageEvent('message', { data: arrayBuffer }));
    }
    emitErrorEvent(err) {
        // `ErrorEvent` is not declared globally in `@types/node`, so build a
        // plain `Event` and attach the fields that `extractWebSocketError`
        // reads structurally.
        const event = Object.assign(new Event('error'), { error: err, message: err.message });
        this.dispatchEvent(event);
    }
    close(code = 1000, reason = '') {
        if (this.closed)
            return;
        this.closed = true;
        this.readyState = WebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close', { code, reason }));
    }
}
//# sourceMappingURL=mock-websocket.js.map