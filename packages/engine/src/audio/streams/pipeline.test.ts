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

	it('speaks a latency filler first but reports TTFT from the model token', async () => {
		const sentTexts: string[] = []
		const tts = {
			preSendTextForSynthesis: mock.fn(async (text: string, listener: TtsSynthesisListener) => {
				sentTexts.push(text)
				return {
					pushTextDelta: (delta: string) => sentTexts.push(delta),
					triggerSynthesisStart: () => listener.onAudioChunk(Buffer.alloc(640)),
					audioComplete: Promise.resolve(),
				}
			}),
		}
		let now = 0
		const clock = { now: () => now }
		const events = (async function* () {
			await new Promise((r) => setTimeout(r, 60))
			now = 500
			yield { type: 'token' as const, value: 'Three works.' }
			return 'Three works.'
		})()

		const pipeline = createPipeline({
			tts: tts as never,
			sanitize: (text) => text,
			sink: createSink(),
			signal: new AbortController().signal,
			clock,
			source: { kind: 'tokens', events, latencyFiller: { delayMs: 10, filler: () => 'Hmm.' } },
		})
		const result = await pipeline.completion

		assert.equal(result.agentResponse, 'Hmm. Three works.')
		assert.equal(result.ttftMs, 500, 'TTFT measures the model, not the filler')
		assert.ok(sentTexts.join('').startsWith('Hmm.'))
	})
})
