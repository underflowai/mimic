/**
 * MCP tool discovery and execution.
 *
 * Connect to any MCP server and use its tools in a voice call —
 * zero wrapping, zero Zod schemas. The MCP server already has
 * tool names, descriptions, and parameter schemas.
 *
 * @example
 * ```typescript
 * const tools = await mimic.mcp('http://localhost:3000/mcp')
 *
 * const call = mimic.call({
 *   to: '+15551234567',
 *   goal: 'Book an appointment',
 *   tools,
 * })
 * ```
 */

// Lazy-imported to avoid pulling ajv/zod-to-json-schema into the main bundle
type MCPClient = import('@modelcontextprotocol/sdk/client/index.js').Client

import { z } from 'zod'

import type { MimicTool, ToolInput } from './types.js'

/** MCP annotation hints → read/write classification. Conservative: anything that isn't declared read-only counts as a write unless it's clearly a query. */
function classifyMcpTool(annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }): 'read' | 'write' {
	if (annotations?.readOnlyHint === true) return 'read'
	if (annotations?.readOnlyHint === false || annotations?.destructiveHint === true) return 'write'
	return 'read'
}

function createMcpTool(
	client: MCPClient,
	toolName: string,
	description: string,
	inputSchema: Record<string, unknown>,
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean },
): MimicTool {
	const zodSchema = z.record(z.unknown())

	return {
		__mimicTool: true,
		description,
		schema: zodSchema,
		kind: classifyMcpTool(annotations),
		async run(input: unknown) {
			const args = (input ?? {}) as Record<string, unknown>
			const result = await client.callTool({ name: toolName, arguments: args })
			const content = result.content as Array<{ type: string; text?: string }>
			const text = content
				.filter((c) => c.type === 'text' && c.text)
				.map((c) => c.text)
				.join('\n')
			return text || JSON.stringify(result.content)
		},
		// The real JSON Schema rides along so introspectTools can put it on the wire.
		_mcpMeta: { toolName, inputSchema },
	} as MimicTool & { _mcpMeta: unknown }
}

export interface McpConnectionOptions {
	/** Custom headers for the HTTP transport. */
	headers?: Record<string, string>
}

/**
 * Connect to an MCP server and discover its tools. Returns a
 * `Record<string, ToolInput>` that can be spread directly into
 * the `tools` field of a call.
 *
 * @example
 * ```typescript
 * // HTTP MCP server
 * const tools = await connectMcp('http://localhost:3000/mcp')
 *
 * // With auth
 * const tools = await connectMcp('https://api.example.com/mcp', {
 *   headers: { Authorization: 'Bearer sk-...' },
 * })
 *
 * // Use in a call
 * mimic.call({ to: '...', goal: '...', tools })
 * ```
 */
export async function connectMcp(
	url: string,
	options?: McpConnectionOptions,
): Promise<Record<string, ToolInput>> {
	const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
	const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')

	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: options?.headers ? { headers: options.headers } : undefined,
	})

	const client = new Client({ name: 'mimic-sdk', version: '0.1.0' })
	await client.connect(transport)

	const { tools: mcpTools } = await client.listTools()

	const tools: Record<string, ToolInput> = {}
	for (const mcpTool of mcpTools) {
		tools[mcpTool.name] = createMcpTool(
			client,
			mcpTool.name,
			mcpTool.description ?? mcpTool.name,
			(mcpTool.inputSchema ?? {}) as Record<string, unknown>,
			mcpTool.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined,
		)
	}

	return tools
}
