import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTurnControlBlockBuilder, type TurnControlBlockContext } from './turn-control-block-builder.js'

function createBuilderHarness() {
	let capturedCtx: TurnControlBlockContext | null = null
	let strategyCallCount = 0

	const builder = createTurnControlBlockBuilder({
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
	it('defaults to empty tool context when no options provided', () => {
		const harness = createBuilderHarness()
		harness.builder.build('hello', { interruptContext: null })

		const ctx = harness.getContext()
		assert.equal(ctx.toolResults, undefined)
		assert.equal(ctx.executingTools, undefined)
	})

	it('passes through explicit tool context from opts', () => {
		const harness = createBuilderHarness()
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

	it('appends explicit tool result alongside base results', () => {
		const harness = createBuilderHarness()
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

	it('silenceFollowUp flows through strategy and appends probe guidance with retry count', () => {
		const harness = createBuilderHarness()
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
		assert.match(block, /One sentence/i)
	})

	it('silenceClosing appends goodbye guidance through the strategy path', () => {
		const harness = createBuilderHarness()
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
		assert.match(block, /stayed quiet after a couple of gentle check-ins/i)
		assert.match(block, /goodbye/i)
		assert.match(block, /no question/i)
	})

	it('does not append silence guidance unless silenceFollowUp is explicitly set', () => {
		const harness = createBuilderHarness()
		const block = harness.builder.build(
			'',
			{ interruptContext: null },
			{ silenceClosing: true, silenceFollowUp: false },
		)

		assert.equal(harness.getStrategyCallCount(), 1)
		assert.doesNotMatch(block, /Silence check-in/i)
	})
})
