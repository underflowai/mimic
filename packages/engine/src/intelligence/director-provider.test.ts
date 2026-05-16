import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { config } from '#engine/config.js'

import { resolveVoiceDirectorProvider } from './director-provider.js'

describe('resolveVoiceDirectorProvider', () => {
	it('defaults to openai when env is unset', async () => {
		const original = process.env.MIMIC_DIRECTOR_PROVIDER
		delete process.env.MIMIC_DIRECTOR_PROVIDER
		try {
			const result = await resolveVoiceDirectorProvider()
			assert.equal(result.provider, 'openai')
			assert.equal(result.model, config.mimic.director.openaiModel)
		} finally {
			if (original !== undefined) process.env.MIMIC_DIRECTOR_PROVIDER = original
		}
	})

	it('selects anthropic when env is set to anthropic', async () => {
		const original = process.env.MIMIC_DIRECTOR_PROVIDER
		process.env.MIMIC_DIRECTOR_PROVIDER = 'anthropic'
		try {
			const result = await resolveVoiceDirectorProvider()
			assert.equal(result.provider, 'anthropic')
			assert.equal(result.model, config.mimic.director.anthropicModel)
		} finally {
			if (original !== undefined) {
				process.env.MIMIC_DIRECTOR_PROVIDER = original
			} else {
				delete process.env.MIMIC_DIRECTOR_PROVIDER
			}
		}
	})
})
