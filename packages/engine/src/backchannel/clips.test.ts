import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadBackchannelClips } from './clips.js'

describe('loadBackchannelClips', () => {
	it('loads default (Sarah) clips as a map of Buffers', async () => {
		const clips = await loadBackchannelClips()
		assert.ok(clips instanceof Map)
		assert.ok(clips.size > 0, 'expected at least one clip')
		for (const [token, buf] of clips) {
			assert.equal(typeof token, 'string')
			assert.ok(Buffer.isBuffer(buf), `expected Buffer for token "${token}"`)
			assert.ok(buf.length > 0, `clip "${token}" should not be empty`)
		}
	})

	it('returns the same promise for repeated calls with the same voice', async () => {
		const p1 = loadBackchannelClips('Sarah')
		const p2 = loadBackchannelClips('Sarah')
		assert.strictEqual(p1, p2)
	})

	it('loads Nate voice clips', async () => {
		const clips = await loadBackchannelClips('Nate')
		assert.ok(clips instanceof Map)
		assert.ok(clips.size > 0, 'expected at least one clip for Nate')
	})
})
