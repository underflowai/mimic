import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { models, supportsTemperature } from './models.js'

describe('supportsTemperature', () => {
	it('is false for the chat-latest alias regardless of effort', () => {
		assert.equal(supportsTemperature('chat-latest'), false)
		assert.equal(supportsTemperature('chat-latest', 'none'), false)
	})

	it('is false whenever a reasoning effort above none is sent', () => {
		assert.equal(supportsTemperature('gpt-6-luna', 'low'), false)
		assert.equal(supportsTemperature('gpt-6.1-sol', 'high'), false)
		assert.equal(supportsTemperature('gpt-5.4-mini', 'medium'), false)
	})

	it('is false for gpt-5.5 with no effort sent, which defaults to reasoning', () => {
		assert.equal(supportsTemperature('gpt-5.5'), false)
		assert.equal(supportsTemperature('gpt-5.5', 'none'), true)
	})

	it('is true at effort none or with no effort for non-reasoning models', () => {
		assert.equal(supportsTemperature('gpt-5.4-mini'), true)
		assert.equal(supportsTemperature('gpt-6-luna', 'none'), true)
		assert.equal(supportsTemperature('claude-haiku-4-5'), true)
	})

	it('matches how the registry entries are called', () => {
		const { openai, anthropic } = models.director
		assert.deepEqual(openai, { model: 'chat-latest' })
		assert.equal(supportsTemperature(openai.model, openai.reasoningEffort), false)
		assert.equal(supportsTemperature(anthropic.model), true)
		assert.equal(supportsTemperature(models.background.model, models.background.reasoningEffort), false)
		assert.equal(supportsTemperature(models.webSearch.model), false)
		assert.equal(supportsTemperature(models.toolWatcher.model, models.toolWatcher.reasoningEffort), false)
		assert.equal(supportsTemperature(models.goalCompiler.model, models.goalCompiler.reasoningEffort), false)
		assert.equal(supportsTemperature(models.resultExtractor.model, models.resultExtractor.reasoningEffort), false)
	})
})
