/**
 * Fake AudioTransport + AudioSink for tests.
 *
 * Accepts PCM writes and stashes them so tests can inspect what was
 * sent to the "LiveKit side" of the pipeline. `waitForPlayout()`
 * resolves synchronously on the next microtask; `clearQueue()` just
 * flags the sink.
 */
import { Writable } from 'node:stream';
class FakeSink extends Writable {
    chunks = [];
    directFrames = [];
    clearQueueCount = 0;
    waitForPlayoutCount = 0;
    constructor() {
        super({ decodeStrings: false, highWaterMark: 1 });
    }
    _write(chunk, _enc, cb) {
        this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
        cb();
    }
    async waitForPlayout() {
        this.waitForPlayoutCount++;
        await new Promise((r) => setImmediate(r));
    }
    clearQueue() {
        this.clearQueueCount++;
    }
    async writeFrameDirect(chunk) {
        this.directFrames.push(Buffer.from(chunk));
    }
}
export function createFakeAudioTransport() {
    const sinks = [];
    const backchannelFrames = [];
    let open = true;
    return {
        sinks,
        backchannelFrames,
        createSink() {
            const sink = new FakeSink();
            sinks.push(sink);
            return sink;
        },
        playBackchannelFrame(chunk) {
            backchannelFrames.push(Buffer.from(chunk));
        },
        isOpen: () => open,
        async close() {
            open = false;
        },
        allWrittenChunks() {
            return sinks.flatMap((s) => [...s.chunks, ...s.directFrames]);
        },
    };
}
//# sourceMappingURL=fake-audio-transport.js.map