import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTurnControlBlockBuilder, type TurnControlBlockContext } from './turn-control-block-builder.js'

async function createBuilderHarness() {
	let capturedCtx: TurnControlBlockContext | null = null
	let strategyCallCount = 0

	const builder = await createTurnControlBlockBuilder({
		getUserFirstName: () => 'Ola',
		getRecipient: () => ({ firstName: 'Ola' }),
		getUserTimezone: () => 'America/New_York',
		buildTurnControlBlock: (ctx) => {
			strategyCallCount++
			capturedCtx = ctx
			return 'block'
		},
	})

	return {
		builder,
		getContext() {
			assert.ok(capturedCtx, 'expected context to be captured')
			return capturedCtx
		},
		getStrategyCallCount() {
			return strategyCallCount
		},
	}
}

describe('createTurnControlBlockBuilder', () => {
	it('defaults to empty tool context when no options provided', async () => {
		const harness = await createBuilderHarness()
		harness.builder.build('hello', { interruptContext: null })

		const ctx = harness.getContext()
		assert.equal(ctx.toolResults, undefined)
		assert.equal(ctx.executingTools, undefined)
	})

	it('passes through explicit tool context from opts', async () => {
		const harness = await createBuilderHarness()
		harness.builder.build(
			'hello',
			{ interruptContext: null },
			{
				toolResults: [{ topic: 'explicit', result: 'cached' }],
				executingTools: ['pending query'],
			},
		)

		const ctx = harness.getContext()
		assert.deepEqual(ctx.toolResults, [{ topic: 'explicit', result: 'cached' }])
		assert.deepEqual(ctx.executingTools, ['pending query'])
	})

	it('appends explicit tool result alongside base results', async () => {
		const harness = await createBuilderHarness()
		harness.builder.build(
			'follow-up',
			{ interruptContext: null },
			{
				toolResults: [{ topic: 'base', result: 'base-result' }],
				toolResult: { topic: 'new', result: 'new-result' },
			},
		)

		const ctx = harness.getContext()
		assert.deepEqual(ctx.toolResults, [
			{ topic: 'new', result: 'new-result' },
			{ topic: 'base', result: 'base-result' },
		])
		assert.equal(ctx.silenceFollowUp, false)
		assert.equal(ctx.silenceClosing, false)
		assert.equal(ctx.silenceFollowUpCount, null)
	})

	it('silenceFollowUp flows through strategy and appends probe guidance with retry count', async () => {
		const harness = await createBuilderHarness()
		const block = harness.builder.build(
			'',
			{ interruptContext: null },
			{ silenceFollowUp: true, silenceFollowUpCount: 1 },
		)

		assert.equal(harness.getStrategyCallCount(), 1, 'silence turns are built through the voice strategy')
		const ctx = harness.getContext()
		assert.equal(ctx.silenceFollowUp, true)
		assert.equal(ctx.silenceClosing, false)
		assert.equal(ctx.silenceFollowUpCount, 1)
		assert.match(block, /caller has been quiet/i)
		assert.match(block, /Are you still there/)
		assert.match(block, /Do not repeat or rephrase the unanswered workflow question/)
		assert.match(block, /one-sentence check-in/i)
		assert.match(block, /two short sentences/i)
	})

	it('silenceClosing appends goodbye guidance through the strategy path', async () => {
		const harness = await createBuilderHarness()
		const block = harness.builder.build(
			'',
			{ interruptContext: null },
			{ silenceFollowUp: true, silenceClosing: true, silenceFollowUpCount: 3 },
		)

		assert.equal(harness.getStrategyCallCount(), 1, 'silence closing keeps strategy context')
		const ctx = harness.getContext()
		assert.equal(ctx.silenceFollowUp, true)
		assert.equal(ctx.silenceClosing, true)
		assert.equal(ctx.silenceFollowUpCount, 3)
		assert.match(block, /stayed quiet after repeated check-ins/i)
		assert.match(block, /goodbye/i)
		assert.match(block, /no question/i)
	})

	it('does not append silence guidance unless silenceFollowUp is explicitly set', async () => {
		const harness = await createBuilderHarness()
		const block = harness.builder.build(
			'',
			{ interruptContext: null },
			{ silenceClosing: true, silenceFollowUp: false },
		)

		assert.equal(harness.getStrategyCallCount(), 1)
		assert.doesNotMatch(block, /quiet/i)
	})

	it('always appends runtime cadence while using compiled or generic transcript guidance', async () => {
		const deps = {
			getUserFirstName: () => 'Ola',
			getRecipient: () => undefined,
			getUserTimezone: () => undefined,
			buildTurnControlBlock: () => '',
		}
		const compiled = await createTurnControlBlockBuilder({ ...deps, textQualityBlock: 'COMPILED BLOCK' })
		const compiledBlock = compiled.build('hi', { interruptContext: null })
		assert.match(compiledBlock, /COMPILED BLOCK/)
		assert.match(compiledBlock, /Follow the caller's latest intent/)
		assert.match(compiledBlock, /mid-conversation on a live phone call/)
		assert.match(compiledBlock, /Do not echo or paraphrase the caller merely to show listening/)
		assert.match(compiledBlock, /one turn in three, open with a filler/)
		assert.doesNotMatch(compiledBlock, /Voice transcription/)
		assert.ok(compiledBlock.indexOf('COMPILED BLOCK') < compiledBlock.indexOf('mid-conversation on a live phone call'))

		const persona = await createTurnControlBlockBuilder(deps)
		const personaBlock = persona.build('hi', { interruptContext: null })
		assert.match(personaBlock, /mid-conversation on a live phone call/)
		assert.match(personaBlock, /Do not echo or paraphrase the caller merely to show listening/)
		assert.match(personaBlock, /one turn in three, open with a filler/)
		assert.match(personaBlock, /Voice transcription/)
		assert.match(personaBlock, /Follow the caller's latest intent/)
	})

	it('adds the confirm-lightly steer only while the timezone is an unconfirmed guess', async () => {
		const deps = {
			getUserFirstName: () => 'Ola',
			getRecipient: () => undefined,
			buildTurnControlBlock: () => '',
		}
		const guessed = await createTurnControlBlockBuilder({
			...deps,
			getUserTimezone: () => 'America/New_York',
			getUserTimezoneInferred: () => true,
		})
		assert.match(guessed.build('hi', { interruptContext: null }), /guess from their area code/)

		const confirmed = await createTurnControlBlockBuilder({
			...deps,
			getUserTimezone: () => 'America/New_York',
			getUserTimezoneInferred: () => false,
		})
		assert.doesNotMatch(confirmed.build('hi', { interruptContext: null }), /area code/)

		const unknown = await createTurnControlBlockBuilder({
			...deps,
			getUserTimezone: () => undefined,
			getUserTimezoneInferred: () => true,
		})
		assert.doesNotMatch(unknown.build('hi', { interruptContext: null }), /area code/)
	})

	it('appends the end-call tag guidance only when enabled', async () => {
		const deps = {
			getUserFirstName: () => 'Ola',
			getRecipient: () => undefined,
			getUserTimezone: () => undefined,
			buildTurnControlBlock: () => '',
		}
		const enabled = await createTurnControlBlockBuilder({ ...deps, endCallEnabled: true })
		assert.match(enabled.build('bye', { interruptContext: null }), /end your reply with the tag \[end-call\]/)

		const disabled = await createTurnControlBlockBuilder(deps)
		assert.doesNotMatch(disabled.build('bye', { interruptContext: null }), /\[end-call\]/)
	})
})
