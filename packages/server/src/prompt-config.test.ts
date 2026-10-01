import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	compilerRevision,
	defaultToolKind,
	hashPromptConfig,
	normalizeCallTools,
	type PromptConfig,
} from './prompt-config.js'

const config: PromptConfig = { goal: 'Confirm a time', voice: 'female', tools: [], results: {} }

describe('prompt configuration', () => {
	it('uses the caller-facing cadence compiler revision', () => {
		assert.equal(compilerRevision, 'voice-prompts-v4')
	})

	it('preserves declared kinds and parameter types; an undeclared kind is a read, as before kind existed', () => {
		const parameters = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }
		assert.deepEqual(
			normalizeCallTools([
				{ name: 'lookup', description: 'Look up a record', kind: 'read', parameters },
				{ name: 'book', description: 'Book a time', kind: 'write' },
				{ name: 'legacy', description: 'Unclassified tool' },
			]),
			[
				{ name: 'lookup', description: 'Look up a record', kind: 'read', parameters },
				{ name: 'book', description: 'Book a time', kind: 'write', parameters: {} },
				{ name: 'legacy', description: 'Unclassified tool', kind: defaultToolKind, parameters: {} },
			],
		)
		assert.equal(defaultToolKind, 'read')
	})

	it('rejects unsupported kinds', () => {
		assert.throws(() => normalizeCallTools([{ name: 'x', description: '', kind: 'other' as 'read' }]), /kind must/)
	})

	it('invalidates compiled prompt cache when compiler revision changes', () => {
		assert.notEqual(hashPromptConfig('key', config, 'old'), hashPromptConfig('key', config, 'new'))
	})

	it('compiles once per goal: the recipient is runtime context, not part of the prompt cache key', () => {
		const forAlex = { ...config, recipient: { firstName: 'Alex' } } as PromptConfig & { recipient: unknown }
		const forSam = { ...config, recipient: { firstName: 'Sam' } } as PromptConfig & { recipient: unknown }
		assert.equal(hashPromptConfig('key', forAlex), hashPromptConfig('key', forSam))
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
