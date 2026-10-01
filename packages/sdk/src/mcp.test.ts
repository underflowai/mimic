import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { createMcpTool } from './mcp.js'
import { executeTool, introspectTools } from './tools.js'

const inputSchema = {
	type: 'object',
	properties: {
		enabled: { type: 'boolean' },
		count: { type: 'integer' },
		options: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
	},
	required: ['enabled', 'options'],
	additionalProperties: false,
}

describe('MCP tool metadata', () => {
	it('preserves original input schema and trusts only explicit readOnlyHint true for reads', () => {
		const client = {} as Parameters<typeof createMcpTool>[0]
		for (const hint of [undefined, false, true]) {
			const discovered = createMcpTool(client, 'lookup', 'Lookup options', inputSchema, hint)
			const [schema] = introspectTools({ lookup: discovered })
			assert.equal(schema!.kind, hint === true ? 'read' : 'write')
			assert.equal(schema!.parameters, inputSchema)
		}
	})

	it('passes typed arguments to the MCP server unchanged', async () => {
		const callTool = mock.fn(async (_input: unknown) => ({ content: [{ type: 'text', text: 'Found results' }] }))
		const client = { callTool } as unknown as Parameters<typeof createMcpTool>[0]
		const discovered = createMcpTool(client, 'lookup', 'Lookup options', inputSchema, true)
		const args = { enabled: false, count: 0, options: ['a'] }
		assert.equal(await executeTool({ lookup: discovered }, 'lookup', args), 'Found results')
		assert.deepEqual(callTool.mock.calls[0]!.arguments[0], { name: 'lookup', arguments: args })
	})
})
