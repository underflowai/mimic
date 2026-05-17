import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { config } from '#engine/config.js'

import { resolveVoiceDirectorProvider } from './director-provider.js'

process.env.OPENAI_API_KEY ??= 'test-openai-key'
process.env.ANTHROPIC_API_KEY ??= 'test-anthropic-key'

describe('resolveVoiceDirectorProvider', () => {
	it('defaults to openai when env is unset', async () => {
		const original = process.env.MIMIC_DIRECTOR_PROVIDER
		delete process.env.MIMIC_DIRECTOR_PROVIDER
		try {
			const result = await resolveVoiceDirectorProvider()
			assert.equal(result.provider, 'openai')
			assert.equal(result.model, config.mimic.director.defaultOpenaiModel)
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
			assert.equal(result.model, config.mimic.director.defaultAnthropicModel)
		} finally {
			if (original !== undefined) {
				process.env.MIMIC_DIRECTOR_PROVIDER = original
			} else {
				delete process.env.MIMIC_DIRECTOR_PROVIDER
			}
		}
	})

	it('throws when provider env value is invalid', async () => {
		const original = process.env.MIMIC_DIRECTOR_PROVIDER
		process.env.MIMIC_DIRECTOR_PROVIDER = 'unknown-provider'
		try {
			await assert.rejects(() => resolveVoiceDirectorProvider(), /MIMIC_DIRECTOR_PROVIDER must be "openai" or "anthropic"/)
		} finally {
			if (original !== undefined) {
				process.env.MIMIC_DIRECTOR_PROVIDER = original
			} else {
				delete process.env.MIMIC_DIRECTOR_PROVIDER
			}
		}
	})
})
