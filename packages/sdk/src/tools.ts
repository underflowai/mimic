import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import type { ZodError, ZodType } from 'zod'

import type { MimicTool, ToolInput, ToolSchema } from './types.js'

// ── tool() helper ─────────────────────────────────────────────────────

/**
 * Define a type-safe tool. The Zod schema is the single source of truth
 * for parameter names, types, and descriptions. The `run` handler's
 * input is inferred automatically.
 *
 * @example
 * ```typescript
 * import { z } from 'zod'
 * import { tool } from '@underflowai/mimic'
 *
 * const checkCalendar = tool({
 *   description: 'Check available calendar slots',
 *   kind: 'read',
 *   parameters: z.object({
 *     date: z.string().describe('The date to check'),
 *   }),
 *   run: async ({ date }) => {
 *     return await calendar.getSlots(date)
 *   },
 * })
 * ```
 */
export function tool<T extends ZodType>(opts: {
	description: string
	/** Defaults to write. Declare read only for tools that retrieve information without side effects. */
	kind?: 'read' | 'write'
	parameters: T
	run: (input: T extends ZodType<infer U> ? U : never) => Promise<string> | string
}): MimicTool {
	return {
		__mimicTool: true,
		description: opts.description,
		kind: opts.kind ?? 'write',
		schema: opts.parameters,
		run: opts.run as (input: unknown) => Promise<string> | string,
	}
}

// ── Schema → wire format ──────────────────────────────────────────────

/**
 * Build tool schemas from a tools record for the API wire format.
 *
 * @example
 * ```typescript
 * const schemas = introspectTools({ checkCalendar, bookMeeting })
 * ```
 */
export function introspectTools(tools: Record<string, ToolInput>): ToolSchema[] {
	return Object.entries(tools).map(([name, t]) => {
		const parameters = t._mcpMeta?.inputSchema ?? toJsonSchemaCompat(t.schema, { pipeStrategy: 'input' })
		return { name, description: t.description, kind: t.kind ?? 'write', parameters }
	})
}

// ── Execution ─────────────────────────────────────────────────────────

function formatZodError(toolName: string, err: ZodError): string {
	const issues = err.issues.map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
		return `  - ${path}: ${issue.message}`
	})
	return `Tool "${toolName}" received invalid arguments:\n${issues.join('\n')}`
}

/**
 * Execute a tool by name. Validates args against the Zod schema
 * and returns an instructive error if validation fails.
 *
 * @example
 * ```typescript
 * const result = await executeTool(tools, 'checkCalendar', { date: 'Thursday' })
 * ```
 */
export async function executeTool(
	tools: Record<string, ToolInput>,
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	const t = tools[name]
	if (!t) throw new Error(`Tool "${name}" is not registered`)

	const parsed = t.schema.safeParse(args)
	if (!parsed.success) {
		throw new Error(formatZodError(name, parsed.error))
	}

	const result = await t.run(parsed.data)
	return typeof result === 'string' ? result : JSON.stringify(result)
}
