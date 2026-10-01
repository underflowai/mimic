import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hashPromptConfig, normalizeCallTools, type PromptConfig } from './prompt-config.js'

const config: PromptConfig = { goal: 'Confirm a time', voice: 'female', tools: [], results: {} }

describe('prompt configuration', () => {
	it('preserves read/write kinds and parameter types instead of reclassifying bookings as reads', () => {
		const parameters = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }
		assert.deepEqual(
			normalizeCallTools([
				{ name: 'lookup', description: 'Look up a record', kind: 'read', parameters },
				{ name: 'book', description: 'Book a time', kind: 'write' },
				{ name: 'legacy', description: 'Unclassified action' },
			]),
			[
				{ name: 'lookup', description: 'Look up a record', kind: 'read', parameters },
				{ name: 'book', description: 'Book a time', kind: 'write', parameters: {} },
				{ name: 'legacy', description: 'Unclassified action', kind: 'write', parameters: {} },
			],
		)
	})

	it('rejects unsupported kinds', () => {
		assert.throws(() => normalizeCallTools([{ name: 'x', description: '', kind: 'other' as 'read' }]), /kind must/)
	})

	it('invalidates compiled prompt cache when compiler revision changes', () => {
		assert.notEqual(hashPromptConfig('key', config, 'old'), hashPromptConfig('key', config, 'new'))
	})

	it('does not reuse a prompt containing another recipient or another account context', () => {
		assert.notEqual(
			hashPromptConfig('key', { ...config, recipient: { firstName: 'Alex' } }),
			hashPromptConfig('key', { ...config, recipient: { firstName: 'Sam' } }),
		)
		assert.notEqual(hashPromptConfig('one', config), hashPromptConfig('two', config))
	})

	it('keeps caller-authored persona cache independent of compiler revisions', () => {
		const personaConfig = { ...config, persona: { systemPrompt: 'Answer briefly.' } }
		assert.equal(hashPromptConfig('key', personaConfig, 'old'), hashPromptConfig('key', personaConfig, 'new'))
	})

	it('ignores object key order when hashing the same input', () => {
		assert.equal(
			hashPromptConfig('key', { ...config, data: { a: 1, b: 2 } }),
			hashPromptConfig('key', { ...config, data: { b: 2, a: 1 } }),
		)
	})
})
