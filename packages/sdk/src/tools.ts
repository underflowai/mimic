import { ZodObject, type ZodError, type ZodType } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

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
 * import { tool } from '@mimic/sdk'
 *
 * const bookAppointment = tool({
 *   description: 'Book an appointment slot',
 *   kind: 'write',
 *   parameters: z.object({
 *     date: z.string().describe('The date to book'),
 *   }),
 *   run: async ({ date }) => {
 *     return await calendar.book(date)
 *   },
 * })
 * ```
 */
export function tool<T extends ZodType>(opts: {
	description: string
	parameters: T
	run: (input: T extends ZodType<infer U> ? U : never) => Promise<string> | string
	/** `'read'` (default) looks things up; `'write'` changes real-world state and is held behind the verification gate. */
	kind?: 'read' | 'write'
	/** For WRITE tools: require explicit caller confirmation before execution. Defaults to `true`. */
	requiresConfirmation?: boolean
}): MimicTool {
	return {
		__mimicTool: true,
		description: opts.description,
		schema: opts.parameters,
		run: opts.run as (input: unknown) => Promise<string> | string,
		kind: opts.kind,
		requiresConfirmation: opts.requiresConfirmation,
	}
}

// ── Schema → wire format ──────────────────────────────────────────────

/** Strip metadata keys the server-side validator doesn't need. */
function cleanJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const { $schema: _$schema, $ref: _$ref, definitions: _definitions, ...rest } = schema
	return rest
}

function zodObjectToJsonSchema(schema: ZodType): Record<string, unknown> {
	const converted = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' })
	return cleanJsonSchema(converted as Record<string, unknown>)
}

/**
 * Build tool schemas from a tools record for the API wire format.
 * Emits real JSON Schema — parameter types, enums, required lists —
 * so the server can validate arguments deterministically before
 * execution.
 *
 * @example
 * ```typescript
 * const schemas = introspectTools({ checkCalendar, bookMeeting })
 * ```
 */
export function introspectTools(tools: Record<string, ToolInput>): ToolSchema[] {
	return Object.entries(tools).map(([name, t]) => {
		const kind = t.kind ?? 'read'
		const base = {
			name,
			description: t.description,
			kind,
			...(kind === 'write' ? { requiresConfirmation: t.requiresConfirmation !== false } : {}),
		}

		const mcpMeta = (t as { _mcpMeta?: { inputSchema: Record<string, unknown> } })._mcpMeta
		if (mcpMeta) {
			return { ...base, parameters: cleanJsonSchema(mcpMeta.inputSchema) }
		}

		if (t.schema instanceof ZodObject) {
			return { ...base, parameters: zodObjectToJsonSchema(t.schema) }
		}
		return { ...base, parameters: { type: 'object' } }
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
