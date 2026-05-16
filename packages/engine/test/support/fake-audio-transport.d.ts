/**
 * Fake AudioTransport + AudioSink for tests.
 *
 * Accepts PCM writes and stashes them so tests can inspect what was
 * sent to the "LiveKit side" of the pipeline. `waitForPlayout()`
 * resolves synchronously on the next microtask; `clearQueue()` just
 * flags the sink.
 */
import type { AudioSink, AudioTransport } from '#engine/audio/streams/types.js';
export interface FakeAudioTransport extends AudioTransport {
    sinks: FakeAudioSink[];
    backchannelFrames: Buffer[];
    /** All chunks written across all sinks. */
    allWrittenChunks(): Buffer[];
    /** Close the transport (marks isOpen false). */
    close(): Promise<void>;
}
export interface FakeAudioSink extends AudioSink {
    /** Chunks accepted by _write. */
    chunks: Buffer[];
    /** Chunks written via writeFrameDirect. */
    directFrames: Buffer[];
    clearQueueCount: number;
    waitForPlayoutCount: number;
}
export declare function createFakeAudioTransport(): FakeAudioTransport;
//# sourceMappingURL=fake-audio-transport.d.ts.map