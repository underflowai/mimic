import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { toToolDefinitions } from './client.js'
import { handleToolSocketMessage } from './tools.js'
import type { MimicTool } from './types.js'

describe('handleToolSocketMessage', () => {
	it('runs a registered tool and sends result', async () => {
		const sent: string[] = []
		const tools: Record<string, MimicTool> = {
			checkCalendar: {
				description: 'Check slots',
				async run(args) {
					return `open: ${args.date}`
				},
			},
		}

		await handleToolSocketMessage(
			{ send: (message) => sent.push(String(message)) },
			tools,
			JSON.stringify({
				type: 'tool_call',
				callbackId: 'cb_1',
				toolName: 'checkCalendar',
				toolArgs: { date: 'Tuesday' },
			}),
		)

		assert.deepEqual(JSON.parse(sent[0]!), {
			type: 'tool_result',
			callbackId: 'cb_1',
			result: 'open: Tuesday',
		})
	})

	it('sends tool_error when tool throws', async () => {
		const sent: string[] = []
		const tools: Record<string, MimicTool> = {
			checkCalendar: {
				description: 'Check slots',
				run() {
					throw new Error('calendar down')
				},
			},
		}

		await handleToolSocketMessage(
			{ send: (message) => sent.push(String(message)) },
			tools,
			JSON.stringify({
				type: 'tool_call',
				callbackId: 'cb_2',
				toolName: 'checkCalendar',
				toolArgs: {},
			}),
		)

		assert.deepEqual(JSON.parse(sent[0]!), {
			type: 'tool_error',
			callbackId: 'cb_2',
			error: 'calendar down',
		})
	})
})

describe('toToolDefinitions', () => {
	it('serializes ToolParameter descriptors to wire format', () => {
		const tools: Record<string, MimicTool> = {
			bookMeeting: {
				description: 'Book a meeting',
				parameters: {
					date: { type: 'string', description: 'Meeting date' },
					time: { type: 'string' },
					notes: { type: 'string', required: false },
				},
			},
		}

		const defs = toToolDefinitions(tools)
		assert.equal(defs.length, 1)
		assert.equal(defs[0]!.name, 'bookMeeting')
		assert.equal(defs[0]!.description, 'Book a meeting')
		assert.equal(defs[0]!.parameters.date, 'string — Meeting date')
		assert.equal(defs[0]!.parameters.time, 'string')
		assert.equal(defs[0]!.parameters.notes, 'string (optional)')
	})

	it('handles tools with no parameters', () => {
		const tools: Record<string, MimicTool> = {
			getHours: { description: 'Get business hours' },
		}
		const defs = toToolDefinitions(tools)
		assert.equal(defs.length, 1)
		assert.deepEqual(defs[0]!.parameters, {})
	})

	it('handles empty tools map', () => {
		assert.deepEqual(toToolDefinitions(undefined), [])
		assert.deepEqual(toToolDefinitions({}), [])
	})
})
