import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'

import { executeTool, introspectTools, tool } from './tools.js'
import { Mimic } from './index.js'
import type { ToolSchema } from './types.js'

// ---------------------------------------------------------------------------
// tool()
// ---------------------------------------------------------------------------

describe('tool()', () => {
	it('creates a MimicTool with __mimicTool marker', () => {
		const t = tool({
			description: 'Check slots',
			parameters: z.object({ date: z.string() }),
			run: async ({ date }) => `slots for ${date}`,
		})
		assert.equal(t.__mimicTool, true)
		assert.equal(t.description, 'Check slots')
		assert.equal(t.kind, 'write')
	})

	it('run receives validated input from schema', async () => {
		const t = tool({
			description: 'Book',
			parameters: z.object({ date: z.string(), time: z.string() }),
			run: async ({ date, time }) => `Booked ${date} at ${time}`,
		})
		const result = await t.run({ date: 'Thursday', time: '2pm' })
		assert.equal(result, 'Booked Thursday at 2pm')
	})
})

// ---------------------------------------------------------------------------
// introspectTools
// ---------------------------------------------------------------------------

describe('introspectTools', () => {
	it('preserves types, descriptions, required fields, and explicit read kind', () => {
		const checkCalendar = tool({
			description: 'Check available slots',
			kind: 'read',
			parameters: z.object({
				date: z.string().describe('The date to check'),
				limit: z.number().optional().describe('Max results'),
			}),
			run: async () => '[]',
		})

		const schemas = introspectTools({ checkCalendar })
		assert.equal(schemas.length, 1)
		assert.equal(schemas[0]!.name, 'checkCalendar')
		assert.equal(schemas[0]!.description, 'Check available slots')
		assert.equal(schemas[0]!.kind, 'read')
		assert.deepEqual(schemas[0]!.parameters.properties, {
			date: { type: 'string', description: 'The date to check' },
			limit: { type: 'number', description: 'Max results' },
		})
		assert.deepEqual(schemas[0]!.parameters.required, ['date'])
	})

	it('preserves string type without an invented description', () => {
		const t = tool({
			description: 'Simple',
			parameters: z.object({ query: z.string() }),
			run: async () => 'ok',
		})
		const schemas = introspectTools({ simple: t })
		assert.deepEqual(schemas[0]!.parameters.properties, { query: { type: 'string' } })
		assert.equal(schemas[0]!.kind, 'write')
	})

	it('preserves booleans, numbers, arrays, enums, nested objects, and optional fields', () => {
		const filters = tool({
			description: 'Filter results',
			kind: 'read',
			parameters: z.object({
				enabled: z.boolean(),
				limit: z.number().int(),
				levels: z.array(z.enum(['basic', 'advanced'])),
				details: z.object({ label: z.string().optional(), count: z.number() }),
				note: z.string().optional(),
			}),
			run: async () => 'ok',
		})
		const [schema] = introspectTools({ filters })
		assert.deepEqual(schema!.parameters.required, ['enabled', 'limit', 'levels', 'details'])
		assert.deepEqual(schema!.parameters.properties, {
			enabled: { type: 'boolean' },
			limit: { type: 'integer' },
			levels: { type: 'array', items: { type: 'string', enum: ['basic', 'advanced'] } },
			details: {
				type: 'object',
				properties: { label: { type: 'string' }, count: { type: 'number' } },
				required: ['count'],
				additionalProperties: false,
			},
			note: { type: 'string' },
		})
	})

	it('defaults legacy tool objects without a kind to write', () => {
		const legacy = {
			__mimicTool: true as const,
			description: 'Legacy tool',
			schema: z.object({}),
			run: async () => 'ok',
		}
		assert.equal(introspectTools({ legacy })[0]!.kind, 'write')
	})

	it('sends tool kinds and complete parameter schemas on the call request', async () => {
		let sentTools: ToolSchema[] = []
		const fetchImpl: typeof fetch = async (_url, init) => {
			if (init?.method === 'POST') {
				sentTools = (JSON.parse(String(init.body)) as { tools: ToolSchema[] }).tools
				return new Response(JSON.stringify({ id: 'call_1', status: 'pending' }), { status: 201 })
			}
			return new Response(
				JSON.stringify({
					id: 'call_1',
					status: 'completed',
					transcript: [],
					result: {},
					goalAchieved: false,
					goalAchievedReason: 'Test',
					duration: 0,
					errorMessage: null,
				}),
			)
		}
		const mimic = new Mimic({ apiKey: 'mk_test', fetch: fetchImpl, WebSocket: null })
		const tools = {
			lookup: tool({
				kind: 'read',
				description: 'Lookup',
				parameters: z.object({ enabled: z.boolean(), count: z.number().optional() }),
				run: async () => 'ok',
			}),
			book: tool({ description: 'Book', parameters: z.object({ guests: z.number() }), run: async () => 'ok' }),
		}
		await mimic.call({ to: '+15551234567', goal: 'Check options', tools, pollIntervalMs: 1 }).result
		assert.deepEqual(sentTools, introspectTools(tools))
		assert.equal(sentTools[0]!.kind, 'read')
		assert.equal(sentTools[1]!.kind, 'write')
	})

	it('handles multiple tools', () => {
		const a = tool({ description: 'A', parameters: z.object({ x: z.string() }), run: async () => 'a' })
		const b = tool({ description: 'B', parameters: z.object({ y: z.number() }), run: async () => 'b' })
		const schemas = introspectTools({ a, b })
		assert.equal(schemas.length, 2)
		assert.equal(schemas[0]!.description, 'A')
		assert.equal(schemas[1]!.description, 'B')
	})

	it('handles empty tools record', () => {
		assert.deepEqual(introspectTools({}), [])
	})
})

// ---------------------------------------------------------------------------
// executeTool
// ---------------------------------------------------------------------------

describe('executeTool', () => {
	it('validates args and calls run with parsed input', async () => {
		const t = tool({
			description: 'Book',
			parameters: z.object({ date: z.string(), guests: z.number().default(1) }),
			run: async ({ date, guests }) => `Booked ${date} for ${guests}`,
		})
		const result = await executeTool({ book: t }, 'book', { date: 'Friday' })
		assert.equal(result, 'Booked Friday for 1')
	})

	it('rejects with instructive error on invalid args', async () => {
		const t = tool({
			description: 'Book',
			parameters: z.object({ date: z.string(), email: z.string().email() }),
			run: async () => 'ok',
		})

		try {
			await executeTool({ book: t }, 'book', { date: 123, email: 'not-an-email' })
			assert.fail('should have thrown')
		} catch (err) {
			const msg = (err as Error).message
			assert.ok(msg.includes('Tool "book" received invalid arguments'))
			assert.ok(msg.includes('date'))
			assert.ok(msg.includes('email'))
		}
	})

	it('rejects with instructive error on missing required field', async () => {
		const t = tool({
			description: 'Search',
			parameters: z.object({ query: z.string().describe('Search query') }),
			run: async () => 'ok',
		})

		try {
			await executeTool({ search: t }, 'search', {})
			assert.fail('should have thrown')
		} catch (err) {
			const msg = (err as Error).message
			assert.ok(msg.includes('Tool "search" received invalid arguments'))
			assert.ok(msg.includes('query'))
			assert.ok(msg.includes('Required'))
		}
	})

	it('stringifies non-string results', async () => {
		const t = tool({
			description: 'Get data',
			parameters: z.object({}),
			run: async () => ({ count: 3 }) as unknown as string,
		})
		const result = await executeTool({ getData: t }, 'getData', {})
		assert.equal(result, '{"count":3}')
	})

	it('throws for unregistered tool', async () => {
		await assert.rejects(() => executeTool({}, 'missing', {}), { message: 'Tool "missing" is not registered' })
	})

	it('propagates tool errors', async () => {
		const t = tool({
			description: 'Fail',
			parameters: z.object({}),
			run: async () => {
				throw new Error('database down')
			},
		})
		await assert.rejects(() => executeTool({ fail: t }, 'fail', {}), { message: 'database down' })
	})
})
