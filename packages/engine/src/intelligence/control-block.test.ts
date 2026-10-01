import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTurnControlBlockBuilder } from '../turn-control-block-builder.js'
import {
	appendInterruptContext,
	formatUserDateTime,
	loadControlBlockPrompts,
	type InterruptContext,
} from './control-block-utils.js'

describe('formatUserDateTime', () => {
	it('includes weekday and year for default timezone', () => {
		const s = formatUserDateTime('America/Los_Angeles')
		assert.match(s, /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/)
		assert.match(s, /\d{4}/)
	})
})

// ---------------------------------------------------------------------------
// Control-block prompt fragments
// ---------------------------------------------------------------------------

describe('loadControlBlockPrompts', () => {
	it('loads every fragment trimmed and renders the templates', async () => {
		const prompts = await loadControlBlockPrompts()

		for (const value of [
			prompts.spokenCadence,
			prompts.silenceFollowUp,
			prompts.silenceClosing,
			prompts.transcriptQuality,
			prompts.toolRunning,
			prompts.endCall,
			prompts.toolClassificationFailed,
		]) {
			assert.ok(value.length > 0)
			assert.equal(value, value.trim())
		}

		assert.match(prompts.endCall, /\[end-call\]/)
		const tools = prompts.toolsAvailable({ toolList: 'checkCalendar (check slots)' })
		assert.match(tools, /^Tools available: checkCalendar \(check slots\)\./)
		assert.equal(tools, tools.trim())
	})

	it('is loaded once per process', async () => {
		assert.equal(await loadControlBlockPrompts(), await loadControlBlockPrompts())
	})
})

// ---------------------------------------------------------------------------
// Turn control block builder — shared signal injection
// ---------------------------------------------------------------------------

describe('turn control block builder appends shared signals', () => {
	it('passes strategy block through and appends interrupt context only', async () => {
		const builder = await createTurnControlBlockBuilder({
			getUserFirstName: () => 'Alex',
			getRecipient: () => ({ firstName: 'Alex' }),
			getUserTimezone: () => 'America/New_York',
			buildTurnControlBlock: (ctx) => `${ctx.userFirstName} said: "${ctx.transcript}"`,
		})

		const block = builder.build('What about flood?', {
			interruptContext: { fullDraft: 'I was saying...', sentMs: 500, playedMs: 500, heardPortion: 'I was' },
		})

		assert.match(block, /Alex said: "What about flood\?"/)
		assert.match(block, /Caller cut in/)
		assert.match(block, /Voice transcription/, 'transcript quality guidance should be appended')
		assert.ok(!block.includes('check the conversation above'), 'boilerplate should not be appended')
	})

	it('appends tool lifecycle guidance when tools are executing', async () => {
		const builder = await createTurnControlBlockBuilder({
			getUserFirstName: () => 'Alex',
			getRecipient: () => ({ firstName: 'Alex' }),
			getUserTimezone: () => undefined,
			buildTurnControlBlock: (ctx) => `${ctx.userFirstName} said: "${ctx.transcript}"`,
		})

		const block = builder.build('thanks', { interruptContext: null }, { executingTools: ['bookMeeting'] })

		assert.match(block, /Tool note: bookMeeting/)
		assert.match(block, /Do not announce the outcome/)
	})

	it('appends idle tool guidance when tools are defined but none active', async () => {
		const builder = await createTurnControlBlockBuilder({
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

		assert.match(
			block,
			/Tools available: checkCalendar \(check available slots\), bookAppointment \(book an appointment\)\./,
		)
		assert.match(block, /do NOT confirm any outcome before the result arrives/)
	})

	it('emits nothing when no tools are defined', async () => {
		const builder = await createTurnControlBlockBuilder({
			getUserFirstName: () => 'Alex',
			getRecipient: () => ({ firstName: 'Alex' }),
			getUserTimezone: () => undefined,
			buildTurnControlBlock: (ctx) => `${ctx.userFirstName} said: "${ctx.transcript}"`,
		})

		const block = builder.build('hi there', { interruptContext: null })

		assert.ok(!block.includes('Tools available'))
		assert.ok(!block.includes('running'))
	})

	it('does not append sentiment or boilerplate to strategy block', async () => {
		const builder = await createTurnControlBlockBuilder({
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
				playedMs: 1100,
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
				playedMs: 2000,
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
				playedMs: 850,
				heardPortion: 'I can walk you through the submission process',
			},
			expectHeard: true,
			expectUnsaid: true,
		},
		{
			description: 'no-ops on empty heardPortion',
			ctx: { fullDraft: 'anything', sentMs: 0, playedMs: 0, heardPortion: '' },
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
		it(description, async () => {
			const prompts = await loadControlBlockPrompts()
			const parts: string[] = []
			appendInterruptContext(parts, ctx, prompts)
			const block = parts.join('\n')

			if (expectHeard) {
				assert.match(block, /^Caller cut in\. They heard: ".+…"$/m)
			} else {
				assert.equal(parts.length, 0)
			}

			if (expectUnsaid) {
				assert.match(block, /^Unsaid: ".+"$/m)
				assert.match(block, /weave/i)
				assert.doesNotMatch(block, /heard most of it/)
			} else if (expectHeard) {
				assert.ok(!block.includes('Unsaid:'))
				assert.match(block, /don't repeat yourself/)
			}
		})
	}

	it('renders the unsaid remainder of the draft verbatim', async () => {
		const prompts = await loadControlBlockPrompts()
		const parts: string[] = []
		appendInterruptContext(
			parts,
			{ fullDraft: 'First point. Second point.', sentMs: 0, playedMs: 0, heardPortion: 'First point.' },
			prompts,
		)
		assert.equal(
			parts.join('\n'),
			[
				'Caller cut in. They heard: "First point.…"',
				'Unsaid: "Second point."',
				"Address their input. Weave in the unsaid point briefly if still relevant — don't repeat what they heard.",
			].join('\n'),
		)
	})
})
