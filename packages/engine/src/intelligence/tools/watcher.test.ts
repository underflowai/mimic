import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import type OpenAI from 'openai'

import type { ToolDefinition } from './runner.js'
import { isGroundedCallerQuote, watchForToolAction, watcherTurnWindow, type ToolWatcherInput } from './watcher.js'

const lookup: ToolDefinition = {
	name: 'lookup',
	description: 'Check options',
	kind: 'read',
	parameters: {
		type: 'object',
		properties: { count: { type: 'integer' }, flexible: { type: 'boolean' }, note: { type: 'string' } },
		required: ['count', 'flexible'],
	},
}
const book: ToolDefinition = { ...lookup, name: 'book', kind: 'write' }

function fixture(result: Record<string, unknown>) {
	const create = mock.fn(async (_input: { input: string; text: { format: { schema: any } } }) => ({
		output: [
			{
				type: 'message',
				content: [
					{
						type: 'output_text',
						text: JSON.stringify({
							decision: 'execute',
							tool: 'lookup',
							args: { count: 2, flexible: false, note: null },
							missing: null,
							directorNote: 'Checking options.',
							reasoning: 'Requested lookup.',
							writeAuthorizationQuote: null,
							...result,
						}),
					},
				],
			},
		],
	}))
	return { create, client: { responses: { create } } as unknown as OpenAI }
}
const input: ToolWatcherInput = { transcript: 'Check options for two people.', recentTurns: [], tools: [lookup] }

describe('tool watcher', () => {
	it('preserves numeric and boolean arguments and does not require optional values', async () => {
		const { create, client } = fixture({ args: { count: 0, flexible: false, note: null } })
		const result = await watchForToolAction(client, input)
		assert.equal(result.decision, 'execute')
		assert.deepEqual(result.args, { count: 0, flexible: false })
		assert.equal(result.missing, null)
		const schema = create.mock.calls[0].arguments[0].text.format.schema.properties.args.anyOf[0]
		assert.deepEqual(schema.properties.count.anyOf, [{ type: 'integer' }, { type: 'null' }])
		assert.deepEqual(schema.properties.flexible.anyOf, [{ type: 'boolean' }, { type: 'null' }])
		assert.match(create.mock.calls[0].arguments[0].input, /"required":\["count","flexible"\]/)
	})

	it('blocks execution with missing or wrongly typed required values', async () => {
		for (const args of [
			{ count: null, flexible: false },
			{ count: 'two', flexible: false },
			{ count: 2.5, flexible: false },
		]) {
			const { client } = fixture({ args })
			const result = await watchForToolAction(client, input)
			assert.equal(result.decision, 'not_ready')
			assert.deepEqual(result.missing, ['count'])
		}
	})

	it('keeps not_ready blocked even when the model omits its blockers', async () => {
		const { client } = fixture({ decision: 'not_ready', missing: [] })
		const result = await watchForToolAction(client, input)
		assert.equal(result.decision, 'not_ready')
		assert.deepEqual(result.missing, ['requirements_unresolved'])
	})

	it('requires grounded caller authorization for a write, not an agent quote', async () => {
		for (const writeAuthorizationQuote of [null, 'Invented caller approval', 'I will book that.']) {
			const { client } = fixture({ tool: 'book', writeAuthorizationQuote })
			const result = await watchForToolAction(client, {
				...input,
				tools: [book],
				recentTurns: [{ role: 'agent', content: 'I will book that.' }],
			})
			assert.equal(result.decision, 'not_ready')
			assert.deepEqual(result.missing, ['authorization'])
		}
	})

	it('accepts an explicit caller request without another approval and retains confirmation blockers', async () => {
		const transcript = 'Book it for two people, please.'
		const { client } = fixture({ tool: 'book', writeAuthorizationQuote: transcript })
		assert.equal((await watchForToolAction(client, { ...input, transcript, tools: [book] })).decision, 'execute')
		const blocked = fixture({ tool: 'book', writeAuthorizationQuote: transcript, missing: ['phone_confirmation'] })
		const result = await watchForToolAction(blocked.client, { ...input, transcript, tools: [book] })
		assert.equal(result.decision, 'not_ready')
		assert.deepEqual(result.missing, ['phone_confirmation'])
	})

	it('grounds the authorization quote on words, not on reproducing the whole turn exactly', async () => {
		const callerTurn = 'Um, yeah — go ahead and book it. Oh, and my email is sam@example.com.'
		for (const quote of [
			'go ahead and book it',
			'Yeah, go ahead and book it.',
			'GO AHEAD AND BOOK IT',
			'yeah go ahead and book it oh and my email is sam@example.com',
		]) {
			const { client } = fixture({ tool: 'book', writeAuthorizationQuote: quote })
			const result = await watchForToolAction(client, {
				...input,
				transcript: 'Two people.',
				tools: [book],
				recentTurns: [{ role: 'user', content: callerTurn }],
			})
			assert.equal(result.decision, 'execute', quote)
		}
		for (const quote of ['go ahead and cancel it', 'book it for Tuesday', '']) {
			const { client } = fixture({ tool: 'book', writeAuthorizationQuote: quote })
			const result = await watchForToolAction(client, {
				...input,
				transcript: 'Two people.',
				tools: [book],
				recentTurns: [{ role: 'user', content: callerTurn }],
			})
			assert.equal(result.decision, 'not_ready', quote)
			assert.deepEqual(result.missing, ['authorization'])
		}
	})

	it('matches whole words only, so a fragment inside another word is not a quote', () => {
		assert.equal(isGroundedCallerQuote('book it', ['Please do not rebook it']), false)
		assert.equal(isGroundedCallerQuote('book it', ['Please book it now']), true)
		assert.equal(isGroundedCallerQuote("that's fine", ['That’s fine, do it.']), true)
		assert.equal(isGroundedCallerQuote(null, ['anything']), false)
	})

	it('preserves shared argument schema variants and filters arguments to the selected tool', async () => {
		const other: ToolDefinition = {
			name: 'other',
			description: 'Other lookup',
			kind: 'read',
			parameters: {
				type: 'object',
				properties: { count: { type: 'string', enum: ['one', 'two'] }, otherOnly: { type: 'string' } },
				required: ['count'],
			},
		}
		const { create, client } = fixture({ args: { count: 2, flexible: false, otherOnly: 'unrelated' } })
		const result = await watchForToolAction(client, { ...input, tools: [lookup, other] })
		assert.deepEqual(result.args, { count: 2, flexible: false })
		const variants =
			create.mock.calls[0].arguments[0].text.format.schema.properties.args.anyOf[0].properties.count.anyOf
		assert.deepEqual(variants, [{ type: 'integer' }, { type: 'string', enum: ['one', 'two'] }, { type: 'null' }])
		const invalid = fixture({ tool: 'other', args: { count: 2 } })
		assert.equal((await watchForToolAction(invalid.client, { ...input, tools: [lookup, other] })).decision, 'not_ready')
	})

	it('keeps collected values when null is emitted and honors supplied corrections', async () => {
		const { client } = fixture({ args: { count: null, flexible: false } })
		const existing = { existingToolName: 'lookup', existingToolArgs: { count: 3, flexible: true } }
		const result = await watchForToolAction(client, { ...input, ...existing })
		assert.deepEqual(result.args, { count: 3, flexible: false })
	})

	it('keeps nested optional slots nullable for output without passing unset fields to tools', async () => {
		const nested: ToolDefinition = {
			name: 'nested',
			description: 'Nested lookup',
			kind: 'read',
			parameters: {
				type: 'object',
				properties: {
					filters: {
						type: 'object',
						properties: { count: { type: 'number' }, note: { type: 'string' } },
						required: ['count'],
					},
				},
				required: ['filters'],
			},
		}
		const { create, client } = fixture({ tool: 'nested', args: { filters: { count: 1, note: null } } })
		const result = await watchForToolAction(client, { ...input, tools: [nested] })
		assert.deepEqual(result.args, { filters: { count: 1 } })
		const schema =
			create.mock.calls[0].arguments[0].text.format.schema.properties.args.anyOf[0].properties.filters.anyOf[0]
		assert.deepEqual(schema.required, ['count', 'note'])
		assert.equal(schema.additionalProperties, false)
		assert.deepEqual(schema.properties.note.anyOf, [{ type: 'string' }, { type: 'null' }])
	})

	it('preserves arrays and enum values and blocks invalid selected-tool variants', async () => {
		const options: ToolDefinition = {
			name: 'options',
			description: 'Find selected options',
			kind: 'read',
			parameters: {
				type: 'object',
				properties: { levels: { type: 'array', items: { type: 'string', enum: ['basic', 'advanced'] } } },
				required: ['levels'],
			},
		}
		const valid = fixture({ tool: 'options', args: { levels: ['basic'] } })
		assert.deepEqual((await watchForToolAction(valid.client, { ...input, tools: [options] })).args, {
			levels: ['basic'],
		})
		const invalid = fixture({ tool: 'options', args: { levels: ['invented'] } })
		assert.deepEqual((await watchForToolAction(invalid.client, { ...input, tools: [options] })).missing, ['levels'])
	})

	it('normalizes nullable object branches before checking the original schema', async () => {
		const nullable: ToolDefinition = {
			name: 'nullable',
			description: 'Filter lookup',
			kind: 'read',
			parameters: {
				type: 'object',
				properties: {
					filters: {
						anyOf: [
							{
								type: 'object',
								properties: { count: { type: 'number' }, note: { type: 'string' } },
								required: ['count'],
								additionalProperties: false,
							},
							{ type: 'null' },
						],
					},
				},
				required: ['filters'],
			},
		}
		const { client } = fixture({ tool: 'nullable', args: { filters: { count: 1, note: null } } })
		const result = await watchForToolAction(client, { ...input, tools: [nullable] })
		assert.equal(result.decision, 'execute')
		assert.deepEqual(result.args, { filters: { count: 1 } })
		const invalid = fixture({ tool: 'nullable', args: { filters: { count: 1, anotherToolsField: 'unrelated' } } })
		assert.deepEqual((await watchForToolAction(invalid.client, { ...input, tools: [nullable] })).missing, ['filters'])
	})

	it('resolves root definitions and keeps referenced constraints when relocating arguments', async () => {
		const referenced: ToolDefinition = {
			name: 'defined',
			kind: 'read',
			description: 'Defined filters',
			parameters: {
				$ref: '#/$defs/input',
				$defs: {
					input: { type: 'object', properties: { count: { $ref: '#/$defs/count', maximum: 5 } }, required: ['count'] },
					count: { type: 'integer', minimum: 0, description: 'Result count' },
				},
			},
		}
		const { create, client } = fixture({ tool: 'defined', args: { count: 0 } })
		const result = await watchForToolAction(client, { ...input, tools: [referenced] })
		assert.equal(result.decision, 'execute')
		const schema = create.mock.calls[0].arguments[0].text.format.schema.properties.args.anyOf[0]
		assert.deepEqual(schema.properties.count.anyOf[0], {
			type: 'integer',
			minimum: 0,
			description: 'Result count',
			maximum: 5,
		})
		assert.doesNotMatch(JSON.stringify(schema), /"\$ref"|"\$defs"/)
		assert.equal(referenced.parameters.$ref, '#/$defs/input')
	})

	it('inlines property references emitted for reused nested Zod objects', async () => {
		const reused: ToolDefinition = {
			name: 'reused',
			kind: 'read',
			description: 'Two filters',
			parameters: {
				type: 'object',
				properties: {
					primary: {
						type: 'object',
						properties: { count: { type: 'number' }, note: { type: 'string' } },
						required: ['count'],
						additionalProperties: false,
					},
					backup: { $ref: '#/properties/primary' },
				},
				required: ['primary', 'backup'],
			},
		}
		const { create, client } = fixture({
			tool: 'reused',
			args: { primary: { count: 1, note: null }, backup: { count: 2, note: null } },
		})
		const result = await watchForToolAction(client, { ...input, tools: [reused] })
		assert.equal(result.decision, 'execute')
		assert.deepEqual(result.args, { primary: { count: 1 }, backup: { count: 2 } })
		const properties = create.mock.calls[0].arguments[0].text.format.schema.properties.args.anyOf[0].properties
		assert.deepEqual(properties.primary, properties.backup)
		assert.doesNotMatch(JSON.stringify(properties), /"\$ref"/)
	})

	it('fails before model or tool execution for recursive, external, or unresolved references', async () => {
		for (const [parameters, reason] of [
			[{ type: 'object', properties: { child: { $ref: '#' } } }, /recursive/],
			[{ type: 'object', properties: { child: { $ref: 'https:\/\/example.com/schema.json' } } }, /external/],
			[{ type: 'object', properties: { child: { $ref: '#/$defs/missing' } } }, /unresolved/],
		] as const) {
			const { create, client } = fixture({ tool: 'unsupported' })
			const result = await watchForToolAction(client, {
				...input,
				tools: [{ name: 'unsupported', description: 'Unsupported', kind: 'read', parameters }],
			})
			assert.equal(result.decision, 'none')
			assert.match(result.reasoning, reason)
			assert.equal(create.mock.calls.length, 0)
		}
	})

	it('drops only the tool with an unusable schema and still runs the others', async () => {
		const broken: ToolDefinition = {
			name: 'broken',
			description: 'Broken',
			kind: 'read',
			parameters: { type: 'object', properties: { child: { $ref: '#' } } },
		}
		const { create, client } = fixture({})
		const result = await watchForToolAction(client, { ...input, tools: [broken, lookup] })
		assert.equal(result.decision, 'execute')
		assert.equal(result.tool, 'lookup')
		const request = create.mock.calls[0].arguments[0]
		assert.match(request.input, /- lookup \[READ\]/)
		assert.doesNotMatch(request.input, /- broken/)
	})

	it('rejects unknown tools and normalizes none so it cannot carry an action', async () => {
		for (const result of [{ tool: 'invented' }, { decision: 'none' }]) {
			const { client } = fixture(result)
			const decision = await watchForToolAction(client, input)
			assert.equal(decision.decision, 'none')
			assert.equal(decision.tool, null)
			assert.equal(decision.args, null)
		}
	})

	it('only exposes explicit cancellation for an existing pending action and a none decision', async () => {
		const pending = { existingToolName: 'lookup', existingToolArgs: { count: 2 } }
		const withdrawal = fixture({ decision: 'none', cancelExisting: true })
		const canceled = await watchForToolAction(withdrawal.client, {
			...input,
			...pending,
			transcript: 'Never mind that lookup.',
		})
		assert.equal(canceled.cancelExisting, true)
		assert.equal(canceled.tool, null)
		assert.equal(canceled.args, null)
		assert.equal((await watchForToolAction(withdrawal.client, input)).cancelExisting, false)

		const ordinaryNone = fixture({ decision: 'none' })
		assert.equal((await watchForToolAction(ordinaryNone.client, { ...input, ...pending })).cancelExisting, false)
		const contradictory = fixture({ decision: 'execute', cancelExisting: true })
		assert.equal((await watchForToolAction(contradictory.client, { ...input, ...pending })).cancelExisting, false)
	})

	it('passes supplied time and the recent turn window, including an earlier authorization inside it', async () => {
		const callerDateTime = '2030-02-01 12:00 Europe/London'
		const { create, client } = fixture({})
		await watchForToolAction(client, {
			...input,
			callerDateTime,
			recentTurns: [
				{ role: 'user', content: 'ANCIENT_REQUEST' },
				...Array.from({ length: watcherTurnWindow - 1 }, () => ({ role: 'agent' as const, content: 'Filler turn.' })),
				{ role: 'user', content: 'EARLIER_REQUEST' },
				...Array.from({ length: 12 }, () => ({ role: 'agent' as const, content: 'A later turn.' })),
			],
		})
		const request = create.mock.calls[0].arguments[0]
		assert.match(request.input, /EARLIER_REQUEST/)
		assert.doesNotMatch(request.input, /ANCIENT_REQUEST/)
		assert.ok(request.input.includes(callerDateTime))
	})
})
