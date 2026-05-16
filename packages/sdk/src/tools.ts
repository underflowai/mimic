import { ZodObject, type ZodError, type ZodType } from 'zod'

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
 * const checkCalendar = tool({
 *   description: 'Check available calendar slots',
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
	parameters: T
	run: (input: T extends ZodType<infer U> ? U : never) => Promise<string> | string
}): MimicTool {
	return {
		__mimicTool: true,
		description: opts.description,
		schema: opts.parameters,
		run: opts.run as (input: unknown) => Promise<string> | string,
	}
}

// ── Schema → wire format ──────────────────────────────────────────────

function describeZodField(key: string, field: ZodType): string {
	const description = field.description
	const isOptional = field.isOptional()

	const parts: string[] = []
	if (description) parts.push(description)
	if (isOptional) parts.push('(optional)')

	return parts.length > 0 ? parts.join(' ') : key
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
		const parameters: Record<string, string> = {}
		if (t.schema instanceof ZodObject) {
			const shape = t.schema.shape as Record<string, ZodType>
			for (const [key, field] of Object.entries(shape)) {
				parameters[key] = describeZodField(key, field)
			}
		}
		return { name, description: t.description, parameters }
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
