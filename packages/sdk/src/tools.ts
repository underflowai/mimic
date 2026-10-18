import type { ZodType } from 'zod'
import { toJSONSchema as zod4ToJsonSchema, type $ZodType } from 'zod/v4/core'
import { zodToJsonSchema } from 'zod-to-json-schema'

import type { MimicTool, ToolInput, ToolSchema, ZodSchemaLike } from './types.js'

/**
 * A tool with no declared `kind` is a read: it runs as soon as the caller's
 * request and its arguments are clear, which is how every tool behaved before
 * `kind` existed. Declare `kind: 'write'` for anything with side effects so
 * the agent waits for the caller's explicit go-ahead before running it.
 */
export const defaultToolKind = 'read'

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
export function tool<T extends ZodSchemaLike>(opts: {
	description: string
	/**
	 * `'read'` (default) runs as soon as the request is clear. `'write'` is for
	 * anything with side effects — booking, sending, updating — and waits for the
	 * caller's explicit go-ahead.
	 */
	kind?: 'read' | 'write'
	/** A Zod object schema (Zod 3 or 4) for the arguments. */
	parameters: T
	run: (input: T['_output']) => Promise<string> | string
}): MimicTool {
	return {
		__mimicTool: true,
		description: opts.description,
		kind: opts.kind ?? defaultToolKind,
		schema: opts.parameters,
		run: opts.run as (input: unknown) => Promise<string> | string,
	}
}

// ── Schema → wire format ──────────────────────────────────────────────

/**
 * JSON Schema for a tool's parameters, preserving types, enums, nesting, and
 * required/optional. Accepts Zod 3 schemas and Zod 4 schemas (from `zod@4` or
 * `zod/v4`), told apart by the `_zod` internals only Zod 4 has.
 */
export function toolParameterSchema(schema: ZodSchemaLike): Record<string, unknown> {
	const json: Record<string, unknown> =
		'_zod' in schema
			? zod4ToJsonSchema(schema as unknown as $ZodType, { io: 'input', unrepresentable: 'any' })
			: zodToJsonSchema(schema as unknown as ZodType, {
					$refStrategy: 'none',
					target: 'jsonSchema7',
					pipeStrategy: 'input',
				})
	// The draft URL is noise on the wire; the server reads the shape, not the dialect.
	const { $schema: _dialect, ...parameters } = json
	return parameters
}

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
		const parameters = t._mcpMeta?.inputSchema ?? toolParameterSchema(t.schema)
		return { name, description: t.description, kind: t.kind ?? defaultToolKind, parameters }
	})
}

// ── Execution ─────────────────────────────────────────────────────────

function formatZodError(
	toolName: string,
	err: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> },
): string {
	const issues = err.issues.map((issue) => {
		const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'
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
