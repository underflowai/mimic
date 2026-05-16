import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { executeTool, introspectTools, parseParameterNames } from './tools.js'
import type { ToolFunction } from './types.js'

// ---------------------------------------------------------------------------
// parseParameterNames
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

	it('extracts param from a single-param arrow without parens', () => {
		const fn = (x: string) => x
		const names = parseParameterNames(fn)
		assert.ok(names.length === 1)
		assert.equal(names[0], 'x')
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

	it('handles destructured parameter', () => {
		const fn = (opts: { date: string; time: string }) => opts
		const names = parseParameterNames(fn)
		assert.equal(names.length, 1)
		assert.equal(names[0], 'opts')
	})

	it('handles default values with nested parens', () => {
		function fn(a: string, b = String(42), c: number) {
			return `${a}${b}${c}`
		}
		assert.deepEqual(parseParameterNames(fn), ['a', 'b', 'c'])
	})

	it('handles mixed named and object params', () => {
		function fn(name: string, opts: { date: string }, limit: number) {
			return `${name}${opts}${limit}`
		}
		const names = parseParameterNames(fn)
		assert.ok(names.includes('name'))
		assert.ok(names.includes('opts'))
		assert.ok(names.includes('limit'))
	})
})

// ---------------------------------------------------------------------------
// introspectTools
// ---------------------------------------------------------------------------

describe('introspectTools', () => {
	it('uses function name as tool name and extracts params', () => {
		function checkCalendar(date: string) {
			return date
		}
		const schemas = introspectTools({ checkCalendar })
		assert.equal(schemas.length, 1)
		assert.equal(schemas[0]!.name, 'checkCalendar')
		assert.equal(schemas[0]!.description, 'checkCalendar')
		assert.deepEqual(schemas[0]!.parameters, ['date'])
	})

	it('uses .description property if set', () => {
		const fn: ToolFunction = (date: string) => date
		fn.description = 'Check available calendar slots'
		const schemas = introspectTools({ checkCalendar: fn })
		assert.equal(schemas[0]!.description, 'Check available calendar slots')
	})

	it('handles multiple tools', () => {
		function checkCalendar(date: string) {
			return date
		}
		function bookMeeting(time: string, email: string) {
			return `${time} ${email}`
		}
		const schemas = introspectTools({ checkCalendar, bookMeeting })
		assert.equal(schemas.length, 2)
		assert.equal(schemas[0]!.name, 'checkCalendar')
		assert.equal(schemas[1]!.name, 'bookMeeting')
		assert.deepEqual(schemas[1]!.parameters, ['time', 'email'])
	})

	it('handles empty tools record', () => {
		assert.deepEqual(introspectTools({}), [])
	})
})

// ---------------------------------------------------------------------------
// executeTool
// ---------------------------------------------------------------------------

describe('executeTool', () => {
	it('calls the function with positional args mapped from param names', async () => {
		function bookMeeting(date: string, time: string) {
			return `Booked ${date} at ${time}`
		}
		const result = await executeTool({ bookMeeting }, 'bookMeeting', { date: 'Thursday', time: '2pm' })
		assert.equal(result, 'Booked Thursday at 2pm')
	})

	it('stringifies non-string return values', async () => {
		function getSlots() {
			return ['2pm', '3pm', '4pm']
		}
		const result = await executeTool({ getSlots }, 'getSlots', {})
		assert.equal(result, '["2pm","3pm","4pm"]')
	})

	it('handles async functions', async () => {
		async function checkCalendar(date: string) {
			return `Slots for ${date}: 2pm, 3pm`
		}
		const result = await executeTool({ checkCalendar }, 'checkCalendar', { date: 'Friday' })
		assert.equal(result, 'Slots for Friday: 2pm, 3pm')
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

	it('passes undefined for unknown param names', async () => {
		function fn(a: unknown, b: unknown) {
			return `${a}-${b}`
		}
		const result = await executeTool({ fn }, 'fn', { a: 'hello' })
		assert.equal(result, 'hello-undefined')
	})
})
