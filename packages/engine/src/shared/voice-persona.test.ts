import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { arloPersona, auroraPersona, voicePersonas } from './voice-persona.js'

describe('voice-persona', () => {
	it('auroraPersona has expected fields', () => {
		assert.equal(auroraPersona.id, 'aurora')
		assert.equal(auroraPersona.firstName, 'Aurora')
		assert.equal(typeof auroraPersona.ttsVoiceId, 'string')
	})

	it('arloPersona has expected fields', () => {
		assert.equal(arloPersona.id, 'arlo')
		assert.equal(arloPersona.firstName, 'Arlo')
		assert.equal(typeof arloPersona.ttsVoiceId, 'string')
	})

	it('voicePersonas lookup matches direct exports', () => {
		assert.strictEqual(voicePersonas.aurora, auroraPersona)
		assert.strictEqual(voicePersonas.arlo, arloPersona)
	})
})
