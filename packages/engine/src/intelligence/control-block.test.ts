import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTurnControlBlockBuilder, type TurnControlBlockContext } from '../turn-control-block-builder.js'
import { appendInterruptContext, formatUserDateTime, type InterruptContext } from './control-block-utils.js'

function makeTurnContext(overrides: Partial<TurnControlBlockContext>) {
	return {
		transcript: '',
		userFirstName: 'Alex',
		interruptContext: null,
		...overrides,
	} satisfies TurnControlBlockContext
}

describe('formatUserDateTime', () => {
	it('includes weekday and year for default timezone', () => {
		const s = formatUserDateTime('America/Los_Angeles')
		assert.match(s, /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/)
		assert.match(s, /\d{4}/)
	})
})

// ---------------------------------------------------------------------------
// Turn control block builder — shared signal injection
// ---------------------------------------------------------------------------

describe('turn control block builder appends shared signals', () => {
	it('passes strategy block through and appends interrupt context only', () => {
		const builder = createTurnControlBlockBuilder({
			getUserFirstName: () => 'Alex',
			getRecipient: () => ({ firstName: 'Alex' }),
			getUserTimezone: () => 'America/New_York',
			buildTurnControlBlock: (ctx) => `${ctx.userFirstName} said: "${ctx.transcript}"`,
		})

		const block = builder.build('What about flood?', {
			interruptContext: { fullDraft: 'I was saying...', sentMs: 500, heardPortion: 'I was' },
		})

		assert.match(block, /Alex said: "What about flood\?"/)
		assert.match(block, /Caller cut in/)
		assert.match(block, /Voice transcription/, 'transcript quality guidance should be appended')
		assert.ok(!block.includes('check the conversation above'), 'boilerplate should not be appended')
	})

	it('appends tool lifecycle guidance when tools are executing', () => {
		const builder = createTurnControlBlockBuilder({
			getUserFirstName: () => 'Alex',
			getRecipient: () => ({ firstName: 'Alex' }),
			getUserTimezone: () => undefined,
			buildTurnControlBlock: (ctx) => `${ctx.userFirstName} said: "${ctx.transcript}"`,
		})

		const block = builder.build('thanks', { interruptContext: null }, { executingTools: ['bookMeeting'] })

		assert.match(block, /Tool note: bookMeeting/)
		assert.match(block, /Do not announce the outcome/)
	})

	it('appends idle tool guidance when tools are defined but none active', () => {
		const builder = createTurnControlBlockBuilder({
			getUserFirstName: () => 'Alex',
			getRecipient: () => ({ firstName: 'Alex' }),
			getUserTimezone: () => undefined,
			buildTurnControlBlock: (ctx) => `${ctx.userFirstName} said: "${ctx.transcript}"`,
		})

		const block = builder.build(
			'hi there',
			{ interruptContext: null },
			{
				toolDefinitions: [
					{ name: 'checkCalendar', description: 'check available slots' },
					{ name: 'bookAppointment', description: 'book an appointment' },
				],
			},
		)

		assert.match(block, /Tools available:/)
		assert.match(block, /checkCalendar/)
		assert.match(block, /bookAppointment/)
		assert.match(block, /do NOT confirm any outcome before the result arrives/)
	})

	it('emits nothing when no tools are defined', () => {
		const builder = createTurnControlBlockBuilder({
			getUserFirstName: () => 'Alex',
			getRecipient: () => ({ firstName: 'Alex' }),
			getUserTimezone: () => undefined,
			buildTurnControlBlock: (ctx) => `${ctx.userFirstName} said: "${ctx.transcript}"`,
		})

		const block = builder.build('hi there', { interruptContext: null })

		assert.ok(!block.includes('Tools available'))
		assert.ok(!block.includes('running'))
	})

	it('does not append sentiment or boilerplate to strategy block', () => {
		const builder = createTurnControlBlockBuilder({
			getUserFirstName: () => 'Jane',
			getRecipient: () => ({ firstName: 'Jane' }),
			getUserTimezone: () => undefined,
			buildTurnControlBlock: (ctx) => `${ctx.userFirstName} said: "${ctx.transcript}"`,
		})

		const block = builder.build('Hello', { interruptContext: null })

		assert.match(block, /Jane said: "Hello"/)
		assert.ok(!block.includes('impatient'))
		assert.ok(!block.includes('Before responding'))
	})
})

// ---------------------------------------------------------------------------
// appendInterruptContext — unsaid portion surfacing
// ---------------------------------------------------------------------------

describe('appendInterruptContext', () => {
	const interruptContextCases: Array<{
		description: string
		ctx: InterruptContext | null
		expectHeard: boolean
		expectUnsaid: boolean
	}> = [
		{
			description: 'renders heard and unsaid portions when caller was cut off mid-thought',
			ctx: {
				fullDraft: 'The policy covers liability. It also includes umbrella coverage.',
				sentMs: 1200,
				heardPortion: 'The policy covers liability.',
			},
			expectHeard: true,
			expectUnsaid: true,
		},
		{
			description: 'renders simple instruction when caller heard everything',
			ctx: {
				fullDraft: 'The deductible is $500.',
				sentMs: 2000,
				heardPortion: 'The deductible is $500.',
			},
			expectHeard: true,
			expectUnsaid: false,
		},
		{
			description: 'handles punctuation-normalized heard prefix',
			ctx: {
				fullDraft: 'I can walk you through the submission process now.',
				sentMs: 900,
				heardPortion: 'I can walk you through the submission process',
			},
			expectHeard: true,
			expectUnsaid: true,
		},
		{
			description: 'no-ops on empty heardPortion',
			ctx: { fullDraft: 'anything', sentMs: 0, heardPortion: '' },
			expectHeard: false,
			expectUnsaid: false,
		},
		{
			description: 'no-ops on null context',
			ctx: null,
			expectHeard: false,
			expectUnsaid: false,
		},
	]

	for (const { description, ctx, expectHeard, expectUnsaid } of interruptContextCases) {
		it(description, () => {
			const parts: string[] = []
			appendInterruptContext(parts, ctx)
			const block = parts.join('\n')

			if (expectHeard) {
				assert.match(block, /They heard:/)
				assert.match(block, /Caller cut in/)
			} else {
				assert.equal(parts.length, 0)
			}

			if (expectUnsaid) {
				assert.match(block, /Unsaid:/)
				assert.match(block, /weave/i)
			} else if (expectHeard) {
				assert.ok(!block.includes('Unsaid:'))
				assert.match(block, /don't repeat yourself/)
			}
		})
	}
})
