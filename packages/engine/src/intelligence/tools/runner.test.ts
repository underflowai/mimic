import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ToolDefinition } from './runner.js'

describe('ToolDefinition', () => {
	it('type allows standard tool shape', () => {
		const tool: ToolDefinition = {
			name: 'checkCalendar',
			description: 'Check available slots',
			kind: 'read',
			parameters: { date: 'The date to check' },
		}

		assert.equal(tool.name, 'checkCalendar')
		assert.equal(typeof tool.parameters, 'object')
	})
})
