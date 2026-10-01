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

// Import network client and transport only when connecting to an MCP server.
type MCPClient = import('@modelcontextprotocol/sdk/client/index.js').Client

import { z } from 'zod'

import type { MimicTool, ToolInput } from './types.js'
import { SDK_VERSION } from './version.js'

/** @internal Adapt one discovered tool while preserving its declared input schema. */
export function createMcpTool(
	client: MCPClient,
	toolName: string,
	description: string,
	inputSchema: Record<string, unknown>,
	readOnlyHint?: boolean,
): MimicTool {
	const zodSchema = z.record(z.unknown())

	return {
		__mimicTool: true,
		description,
		kind: readOnlyHint === true ? 'read' : 'write',
		schema: zodSchema,
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
		_mcpMeta: { toolName, inputSchema },
	}
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
export async function connectMcp(url: string, options?: McpConnectionOptions): Promise<Record<string, ToolInput>> {
	const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
	const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')

	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: options?.headers ? { headers: options.headers } : undefined,
	})

	const client = new Client({ name: '@underflowai/mimic', version: SDK_VERSION })
	await client.connect(transport)

	const { tools: mcpTools } = await client.listTools()

	const tools: Record<string, ToolInput> = {}
	for (const mcpTool of mcpTools) {
		tools[mcpTool.name] = createMcpTool(
			client,
			mcpTool.name,
			mcpTool.description ?? mcpTool.name,
			(mcpTool.inputSchema ?? {}) as Record<string, unknown>,
			mcpTool.annotations?.readOnlyHint,
		)
	}

	return tools
}
