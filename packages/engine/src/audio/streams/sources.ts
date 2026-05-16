/**
 * Source Readables for the outbound audio pipeline.
 *
 * Two source flavors correspond to the active turn strategies:
 *
 *   - Token stream from the LLM (fresh / first_turn).
 *     Consumes the director's async generator and emits text deltas as
 *     object-mode chunks, surfacing the full returned response as a
 *     final event on the `done` promise.
 *   - PCM source for the presynthesized strategy. Replays any
 *     already-buffered PCM from the eager pipeline and subscribes to
 *     subsequent chunks until the TTS session marks itself done.
 */

import { Readable } from 'node:stream'

import type { DirectorStreamEvent, EagerAudioSink } from '../../shared/streaming-types.js'

/**
 * Consumes the director's async generator and pushes text deltas as
 * object-mode chunks. The generator's return value (the full
 * assembled response) is surfaced through `finalResponse` — the TTS
 * transform never sees it directly, but the pipeline actor uses it to
 * decide whether to commit.
 */
export interface TokenReadable {
	stream: Readable
	/** Resolves with the final trimmed response, or '' on empty / abort. */
	finalResponse: Promise<string>
}

export function createTokenReadable(
	events: AsyncGenerator<DirectorStreamEvent, string>,
	signal?: AbortSignal,
): TokenReadable {
	let finalResolve!: (value: string) => void
	let finalReject!: (err: Error) => void
	const finalResponse = new Promise<string>((resolve, reject) => {
		finalResolve = resolve
		finalReject = reject
	})
	let ended = false
	let draining = false

	async function pullOne(stream: Readable) {
		if (draining || ended) return
		draining = true
		try {
			while (!ended) {
				if (signal?.aborted) {
					ended = true
					finalResolve('')
					stream.push(null)
					return
				}
				const iter = await events.next()
				if (iter.done) {
					ended = true
					const returned = typeof iter.value === 'string' ? iter.value.trim() : ''
					finalResolve(returned)
					stream.push(null)
					return
				}
				const event = iter.value
				if (!event || event.type !== 'token' || typeof event.value !== 'string' || event.value.length === 0) {
					continue
				}
				const keepGoing = stream.push(event.value)
				if (!keepGoing) return
			}
		} catch (err) {
			if (signal?.aborted) {
				ended = true
				finalResolve('')
				stream.push(null)
				return
			}
			ended = true
			finalReject(err instanceof Error ? err : new Error(String(err)))
			stream.destroy(err instanceof Error ? err : new Error(String(err)))
		} finally {
			draining = false
		}
	}

	const stream = new Readable({
		objectMode: true,
		read() {
			void pullOne(this)
		},
		async destroy(err, callback) {
			ended = true
			try {
				await events.return('' as never)
			} catch {
				/* swallow */
			}
			if (err) finalReject(err)
			else finalResolve('')
			callback(err)
		},
	})

	return { stream, finalResponse }
}

/**
 * Readable that replays buffered PCM from an `EagerAudioSink` and then
 * follows any additional chunks written through the sink's forward
 * hook. Ends when the sink is marked done or `ttsPromise` settles.
 *
 * Uses the push-on-demand pattern: `read()` pulls from the internal
 * backlog, `sink.forward` pushes new chunks asynchronously. Node's
 * own backpressure handling (highWaterMark) buffers them between
 * reads.
 */
export function createPresynthPcmReadable(sink: EagerAudioSink, ttsPromise: Promise<void> | null): Readable {
	let ended = false

	const stream = new Readable({
		objectMode: false,
		read() {
			/* push-based — see below */
		},
		destroy(err, callback) {
			ended = true
			sink.forward = null
			sink.chunks.length = 0
			callback(err)
		},
	})

	const bufferedChunks = sink.chunks.splice(0, sink.chunks.length)
	for (const chunk of bufferedChunks) stream.push(chunk)

	sink.forward = (chunk: Buffer) => {
		if (ended) return
		stream.push(chunk)
	}

	void (async () => {
		try {
			if (ttsPromise) await ttsPromise
		} catch {
			/* handled by tts interrupt path */
		}
		if (ended) return
		ended = true
		sink.forward = null
		sink.chunks.length = 0
		stream.push(null)
	})()

	// If the sink is already done (all buffered, no more chunks coming),
	// close immediately after the initial flush.
	if (!ttsPromise && sink.done) {
		ended = true
		sink.forward = null
		sink.chunks.length = 0
		stream.push(null)
	}

	return stream
}
