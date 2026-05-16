import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, it, mock } from 'node:test'

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
	return sink
}

describe('createPipeline', () => {
	it('records LLM completion timing separately from first audio', async () => {
		const tts = {
			preSendTextForSynthesis: mock.fn(async (_text: string, onChunk: (chunk: Buffer) => void) => ({
				pushTextDelta: () => {},
				triggerSynthesisStart: () => onChunk(Buffer.alloc(640)),
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
	})
})
