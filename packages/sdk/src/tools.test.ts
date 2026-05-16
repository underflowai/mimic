import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'

import { executeTool, introspectTools, parseParameterNames, tool } from './tools.js'

// ---------------------------------------------------------------------------
// tool() helper
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
	})

	it('run receives validated input from schema', async () => {
		const t = tool({
			description: 'Book',
			parameters: z.object({
				date: z.string(),
				time: z.string(),
			}),
			run: async ({ date, time }) => `Booked ${date} at ${time}`,
		})
		const result = await t.run({ date: 'Thursday', time: '2pm' })
		assert.equal(result, 'Booked Thursday at 2pm')
	})
})

// ---------------------------------------------------------------------------
// introspectTools — structured (Zod)
// ---------------------------------------------------------------------------

describe('introspectTools with tool()', () => {
	it('extracts parameter descriptions from Zod .describe()', () => {
		const checkCalendar = tool({
			description: 'Check available slots',
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
		assert.ok(schemas[0]!.parameters.date.includes('The date to check'))
		assert.ok(schemas[0]!.parameters.limit.includes('Max results'))
	})

	it('uses field name when no .describe() is set', () => {
		const t = tool({
			description: 'Simple',
			parameters: z.object({ query: z.string() }),
			run: async () => 'ok',
		})

		const schemas = introspectTools({ simple: t })
		assert.equal(schemas[0]!.parameters.query, 'query')
	})

	it('handles mix of structured and plain function tools', () => {
		const structured = tool({
			description: 'Structured tool',
			parameters: z.object({ x: z.string() }),
			run: async () => 'ok',
		})
		function plainTool(name: string) {
			return `hi ${name}`
		}

		const schemas = introspectTools({ structured, plainTool })
		assert.equal(schemas.length, 2)
		assert.equal(schemas[0]!.description, 'Structured tool')
		assert.equal(schemas[1]!.name, 'plainTool')
	})
})

// ---------------------------------------------------------------------------
// executeTool — structured (Zod) with validation
// ---------------------------------------------------------------------------

describe('executeTool with tool()', () => {
	it('validates args and calls run with parsed input', async () => {
		const t = tool({
			description: 'Book',
			parameters: z.object({
				date: z.string(),
				guests: z.number().default(1),
			}),
			run: async ({ date, guests }) => `Booked ${date} for ${guests}`,
		})

		const result = await executeTool({ book: t }, 'book', { date: 'Friday' })
		assert.equal(result, 'Booked Friday for 1')
	})

	it('rejects with instructive error on invalid args', async () => {
		const t = tool({
			description: 'Book',
			parameters: z.object({
				date: z.string(),
				email: z.string().email(),
			}),
			run: async () => 'ok',
		})

		try {
			await executeTool({ book: t }, 'book', { date: 123, email: 'not-an-email' })
			assert.fail('should have thrown')
		} catch (err) {
			const msg = (err as Error).message
			assert.ok(msg.includes('Tool "book" received invalid arguments'), `got: ${msg}`)
			assert.ok(msg.includes('date'), `should mention "date" field: ${msg}`)
			assert.ok(msg.includes('email'), `should mention "email" field: ${msg}`)
		}
	})

	it('rejects with instructive error on missing required field', async () => {
		const t = tool({
			description: 'Search',
			parameters: z.object({
				query: z.string().describe('Search query'),
			}),
			run: async () => 'ok',
		})

		try {
			await executeTool({ search: t }, 'search', {})
			assert.fail('should have thrown')
		} catch (err) {
			const msg = (err as Error).message
			assert.ok(msg.includes('Tool "search" received invalid arguments'), `got: ${msg}`)
			assert.ok(msg.includes('query'), `should mention "query" field: ${msg}`)
			assert.ok(msg.includes('Required'), `should say Required: ${msg}`)
		}
	})

	it('stringifies non-string results from structured tools', async () => {
		const t = tool({
			description: 'Get data',
			parameters: z.object({}),
			run: async () => ({ count: 3 }) as unknown as string,
		})

		const result = await executeTool({ getData: t }, 'getData', {})
		assert.equal(result, '{"count":3}')
	})
})

// ---------------------------------------------------------------------------
// parseParameterNames (plain functions)
// ---------------------------------------------------------------------------

describe('parseParameterNames', () => {
	it('extracts params from a named function', () => {
		function checkCalendar(date: string, _timezone: string) {
			void date
			void _timezone
		}
		assert.deepEqual(parseParameterNames(checkCalendar), ['date', '_timezone'])
	})

	it('extracts params from an arrow function with parens', () => {
		const fn = (date: string, time: string) => ({ date, time })
		assert.deepEqual(parseParameterNames(fn), ['date', 'time'])
	})

	it('handles a function with no parameters', () => {
		function getHours() {
			return '9-5'
		}
		assert.deepEqual(parseParameterNames(getHours), [])
	})

	it('strips default values', () => {
		function fn(date: string, limit = 10) {
			return `${date}${limit}`
		}
		assert.deepEqual(parseParameterNames(fn), ['date', 'limit'])
	})

	it('strips rest operator', () => {
		function fn(...items: string[]) {
			void items
		}
		assert.deepEqual(parseParameterNames(fn), ['items'])
	})

	it('handles default values with nested parens', () => {
		function fn(a: string, b = String(42), c: number) {
			return `${a}${b}${c}`
		}
		assert.deepEqual(parseParameterNames(fn), ['a', 'b', 'c'])
	})
})

// ---------------------------------------------------------------------------
// executeTool — plain functions
// ---------------------------------------------------------------------------

describe('executeTool with plain functions', () => {
	it('maps args to positional params', async () => {
		function bookMeeting(date: string, time: string) {
			return `Booked ${date} at ${time}`
		}
		const result = await executeTool({ bookMeeting }, 'bookMeeting', { date: 'Thursday', time: '2pm' })
		assert.equal(result, 'Booked Thursday at 2pm')
	})

	it('throws for unregistered tool', async () => {
		await assert.rejects(() => executeTool({}, 'missing', {}), { message: 'Tool "missing" is not registered' })
	})

	it('propagates tool errors', async () => {
		function failingTool() {
			throw new Error('database down')
		}
		await assert.rejects(() => executeTool({ failingTool }, 'failingTool', {}), { message: 'database down' })
	})
})
