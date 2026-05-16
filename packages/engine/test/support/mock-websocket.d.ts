/**
 * In-process WebSocket stand-in for unit tests.
 *
 * Extends `EventTarget` and dispatches real `Event`/`MessageEvent`/
 * `CloseEvent`/`ErrorEvent` objects so consumers that use the DOM-style
 * `addEventListener` API (as the production transcriber/TTS code now does)
 * see exactly what the real runtime would deliver.
 */
export declare class AutoOpenMockSocket extends EventTarget {
    readyState: number;
    binaryType: 'arraybuffer' | 'blob';
    private closed;
    constructor(options?: {
        openDelayMs?: number;
        autoOpen?: boolean;
    });
    protected get isClosed(): boolean;
    protected get isOpen(): boolean;
    protected emitJsonMessage(payload: unknown): void;
    protected emitErrorEvent(err: Error): void;
    close(code?: number, reason?: string): void;
}
//# sourceMappingURL=mock-websocket.d.ts.map