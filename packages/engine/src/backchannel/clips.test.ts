import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { arloPersona, auroraPersona } from '../shared/voice-persona.js'
import { loadBackchannelClips } from './clips.js'
import { backchannelTokens } from './tokens.js'

describe('loadBackchannelClips', () => {
	for (const persona of [auroraPersona, arloPersona]) {
		it(`loads every token for the ${persona.firstName} voice`, async () => {
			const clips = await loadBackchannelClips(persona.ttsVoiceId)
			assert.ok(clips instanceof Map)
			assert.deepEqual([...clips.keys()].sort(), [...backchannelTokens].sort())
			for (const [token, buf] of clips) {
				assert.ok(Buffer.isBuffer(buf), `expected Buffer for token "${token}"`)
				assert.ok(buf.length > 0, `clip "${token}" should not be empty`)
				assert.equal(buf.length % 2, 0, `clip "${token}" should be whole PCM16 samples`)
			}
		})
	}

	it('returns the same promise for repeated calls with the same voice', () => {
		const p1 = loadBackchannelClips(auroraPersona.ttsVoiceId)
		const p2 = loadBackchannelClips(auroraPersona.ttsVoiceId)
		assert.strictEqual(p1, p2)
	})

	it('rejects for a voice with no generated clips', async () => {
		await assert.rejects(() => loadBackchannelClips('no-such-voice'), /Missing backchannel clip assets/)
	})
})
