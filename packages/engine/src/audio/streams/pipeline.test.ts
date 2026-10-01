import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, it, mock } from 'node:test'

import type { TtsSynthesisListener } from '../tts-speaker.js'
import { createPipeline } from './pipeline.js'
import type { AudioSink } from './types.js'

function createSink(): AudioSink {
	const sink = new Writable({
		write(_chunk, _encoding, callback) {
			callback()
		},
	}) as AudioSink
	sink.waitForPlayout = async () => {}
	sink.clearQueue = () => {}
	sink.writeFrameDirect = async () => {}
	sink.queuedPlayoutMs = () => 0
	return sink
}

describe('createPipeline', () => {
	it('records LLM completion timing separately from first audio', async () => {
		const tts = {
			preSendTextForSynthesis: mock.fn(async (_text: string, listener: TtsSynthesisListener) => ({
				pushTextDelta: () => {},
				triggerSynthesisStart: () => {
					listener.onAudioChunk(Buffer.alloc(640))
					listener.onWordTimings?.([
						{ word: 'Hello', startMs: 0, endMs: 200 },
						{ word: 'there.', startMs: 220, endMs: 500 },
					])
				},
				audioComplete: Promise.resolve(),
			})),
		}
		const events = (async function* () {
			yield { type: 'token' as const, value: 'Hello there.' }
			return 'Hello there.'
		})()

		const pipeline = createPipeline({
			tts: tts as never,
			sanitize: (text) => text,
			sink: createSink(),
			signal: new AbortController().signal,
			source: { kind: 'tokens', events },
		})
		const result = await pipeline.completion

		assert.equal(result.agentResponse, 'Hello there.')
		assert.equal(result.audioSent, true)
		assert.notEqual(result.firstAudioAt, null)
		assert.notEqual(result.ttcMs, null)
		assert.deepEqual(
			pipeline.wordTimeline().map((w) => w.word),
			['Hello', 'there.'],
			'word timings from the speaker are exposed on the pipeline handle',
		)
	})
})
