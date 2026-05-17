import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadPrompt } from './prompts.js'

describe('loadPrompt', () => {
	it('loads known prompt templates', async () => {
		const prompt = await loadPrompt('instructions/tool-watcher')
		assert.ok(prompt.length > 0)
	})

	it('rejects path traversal names', async () => {
		await assert.rejects(() => loadPrompt('../package'), /Invalid prompt name/)
	})
})
