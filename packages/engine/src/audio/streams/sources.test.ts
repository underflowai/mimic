import assert from 'node:assert/strict'
import type { Readable } from 'node:stream'
import { describe, it } from 'node:test'

import type { EagerAudioSink } from '../../shared/streaming-types.js'
import { createPresynthPcmReadable } from './sources.js'

async function readAllChunks(stream: Readable) {
	const chunks: Buffer[] = []
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return chunks
}

describe('createPresynthPcmReadable', () => {
	it('consumes buffered eager chunks only once', async () => {
		const bufferedChunk = Buffer.from('stale-audio')
		const sink: EagerAudioSink = {
			chunks: [bufferedChunk],
			done: true,
			forward: null,
		}

		const firstChunks = await readAllChunks(createPresynthPcmReadable(sink, null))
		assert.equal(firstChunks.length, 1)
		assert.equal(firstChunks[0]?.toString('utf8'), bufferedChunk.toString('utf8'))
		assert.equal(sink.chunks.length, 0)

		const secondChunks = await readAllChunks(createPresynthPcmReadable(sink, null))
		assert.equal(secondChunks.length, 0)
	})
})
