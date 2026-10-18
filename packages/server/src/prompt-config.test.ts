import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	compilerRevision,
	defaultToolKind,
	hashPromptConfig,
	normalizeCallTools,
	type PromptConfig,
} from './prompt-config.js'

const config: PromptConfig = { goal: 'Confirm a time', voice: 'female', tools: [] }

describe('prompt configuration', () => {
	it('uses the compiler revision that keeps data and extract fields out of the prompt', () => {
		assert.equal(compilerRevision, 'voice-prompts-v6')
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

	it('keys a caller-owned prompt by its text, independent of compiler revisions', () => {
		const owned = { ...config, prompt: { systemPrompt: 'Answer briefly.' } }
		assert.equal(hashPromptConfig('key', owned, 'old'), hashPromptConfig('key', owned, 'new'))
		assert.notEqual(
			hashPromptConfig('key', owned),
			hashPromptConfig('key', { ...config, prompt: { systemPrompt: 'Answer briefly.', turnControlBlock: 'Be warm.' } }),
		)
		assert.notEqual(hashPromptConfig('key', owned), hashPromptConfig('key', config))
	})

	it('ignores object key order when hashing the same input', () => {
		const tools = (order: 'ab' | 'ba') =>
			order === 'ab' ? [{ name: 'x', description: 'd', kind: 'read' }] : [{ kind: 'read', description: 'd', name: 'x' }]
		assert.equal(
			hashPromptConfig('key', { ...config, tools: tools('ab') }),
			hashPromptConfig('key', { ...config, tools: tools('ba') }),
		)
	})

	it('belongs to the call, not the agent: data and extract fields never enter the key', () => {
		// The type no longer admits them; this pins the behaviour if they are ever passed anyway.
		const withCallThings = { ...config, data: { appointmentTime: 'Tuesday 3 PM' }, results: { confirmed: 'bool' } }
		assert.equal(hashPromptConfig('key', withCallThings as PromptConfig), hashPromptConfig('key', config))
	})

	it('recompiles for what actually changes the job: goal, context, tools, voice, disclosure', () => {
		for (const change of [
			{ goal: 'Cancel a time' },
			{ context: 'Office closes at 5.' },
			{ tools: [{ name: 'book', description: 'Book it', kind: 'write', parameters: {} }] },
			{ voice: 'male' },
			{ aiDisclosure: false },
		] as Partial<PromptConfig>[]) {
			assert.notEqual(
				hashPromptConfig('key', { ...config, ...change }),
				hashPromptConfig('key', config),
				JSON.stringify(change),
			)
		}
	})
})
