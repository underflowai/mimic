/**
 * Fake AudioTransport + AudioSink for tests.
 *
 * Accepts PCM writes and stashes them so tests can inspect what was
 * sent to the "LiveKit side" of the pipeline. `waitForPlayout()`
 * resolves synchronously on the next microtask; `clearQueue()` just
 * flags the sink.
 */

import { Writable } from 'node:stream'

import type { AudioSink, AudioTransport } from '#engine/audio/streams/types.js'

export interface FakeAudioTransport extends AudioTransport {
	sinks: FakeAudioSink[]
	backchannelFrames: Buffer[]
	/** All chunks written across all sinks. */
	allWrittenChunks(): Buffer[]
	/** Close the transport (marks isOpen false). */
	close(): Promise<void>
}

export interface FakeAudioSink extends AudioSink {
	/** Chunks accepted by _write. */
	chunks: Buffer[]
	/** Chunks written via writeFrameDirect. */
	directFrames: Buffer[]
	clearQueueCount: number
	waitForPlayoutCount: number
}

class FakeSink extends Writable implements FakeAudioSink {
	chunks: Buffer[] = []
	directFrames: Buffer[] = []
	clearQueueCount = 0
	waitForPlayoutCount = 0

	constructor() {
		super({ decodeStrings: false, highWaterMark: 1 })
	}

	override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
		this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)))
		cb()
	}

	async waitForPlayout(): Promise<void> {
		this.waitForPlayoutCount++
		await new Promise((r) => setImmediate(r))
	}

	clearQueue(): void {
		this.clearQueueCount++
	}

	async writeFrameDirect(chunk: Buffer): Promise<void> {
		this.directFrames.push(Buffer.from(chunk))
	}
}

export function createFakeAudioTransport(): FakeAudioTransport {
	const sinks: FakeAudioSink[] = []
	const backchannelFrames: Buffer[] = []
	let open = true

	return {
		sinks,
		backchannelFrames,
		createSink() {
			const sink = new FakeSink()
			sinks.push(sink)
			return sink
		},
		playBackchannelFrame(chunk: Buffer) {
			backchannelFrames.push(Buffer.from(chunk))
		},
		isOpen: () => open,
		async close() {
			open = false
		},
		allWrittenChunks() {
			return sinks.flatMap((s) => [...s.chunks, ...s.directFrames])
		},
	}
}
