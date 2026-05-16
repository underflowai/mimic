import { ZodObject, type ZodError, type ZodType } from 'zod'

import type { MimicTool, ToolInput, ToolSchema } from './types.js'

// ── tool() helper ─────────────────────────────────────────────────────

/**
 * Define a type-safe tool. The Zod schema is the single source of truth
 * for parameter names, types, and descriptions — the `run` handler's
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
 *     // date is typed as string — inferred from schema
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

// ── Type guards ───────────────────────────────────────────────────────

function isStructuredTool(t: ToolInput): t is MimicTool {
	return typeof t === 'object' && '__mimicTool' in t && t.__mimicTool === true
}

// ── Introspection ─────────────────────────────────────────────────────

/**
 * Extract parameter names from a function by parsing its source.
 *
 * Handles named functions, arrow functions, rest params, defaults,
 * destructuring, and nested parens in default values.
 */
export function parseParameterNames(fn: Function): string[] {
	const source = fn.toString()

	const arrowMatch = source.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/)
	if (arrowMatch) return [arrowMatch[1]!]

	const openIdx = source.indexOf('(')
	if (openIdx === -1) return []

	let depth = 0
	let closeIdx = -1
	for (let i = openIdx; i < source.length; i++) {
		if (source[i] === '(') depth++
		else if (source[i] === ')') {
			depth--
			if (depth === 0) {
				closeIdx = i
				break
			}
		}
	}
	if (closeIdx === -1) return []

	const raw = source.slice(openIdx + 1, closeIdx).trim()
	if (!raw) return []

	return extractParamNames(raw)
}

function extractParamNames(raw: string): string[] {
	const params: string[] = []
	let depth = 0
	let current = ''

	for (const ch of raw) {
		if (ch === '(' || ch === '{' || ch === '[') depth++
		else if (ch === ')' || ch === '}' || ch === ']') depth--

		if (ch === ',' && depth === 0) {
			const name = cleanParam(current)
			if (name) params.push(name)
			current = ''
		} else {
			current += ch
		}
	}

	const last = cleanParam(current)
	if (last) params.push(last)

	return params
}

function cleanParam(raw: string): string | null {
	let s = raw.trim()
	if (!s) return null
	if (s.startsWith('...')) s = s.slice(3).trim()
	const eqIdx = s.indexOf('=')
	if (eqIdx > 0) s = s.slice(0, eqIdx).trim()
	if (!s.startsWith('{') && !s.startsWith('[')) {
		const colonIdx = s.indexOf(':')
		if (colonIdx > 0) s = s.slice(0, colonIdx).trim()
	}
	if (s.startsWith('{') || s.startsWith('[')) return null
	if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s)) return s
	return null
}

const paramCache = new WeakMap<Function, string[]>()

function cachedParamNames(fn: Function): string[] {
	let names = paramCache.get(fn)
	if (!names) {
		names = parseParameterNames(fn)
		paramCache.set(fn, names)
	}
	return names
}

// ── Schema → wire format ──────────────────────────────────────────────

function zodSchemaToParameters(schema: ZodType): Record<string, string> {
	const params: Record<string, string> = {}
	const shape = getZodShape(schema)
	if (!shape) return params

	for (const [key, fieldSchema] of Object.entries(shape)) {
		params[key] = describeZodField(key, fieldSchema as ZodType)
	}
	return params
}

function getZodShape(schema: ZodType): Record<string, ZodType> | null {
	if (schema instanceof ZodObject) return schema.shape as Record<string, ZodType>
	return null
}

function describeZodField(key: string, field: ZodType): string {
	const description = field.description
	const isOptional = field.isOptional()

	const parts: string[] = []
	if (description) parts.push(description)
	if (isOptional) parts.push('(optional)')

	return parts.length > 0 ? parts.join(' ') : key
}

// ── Public introspection ──────────────────────────────────────────────

/**
 * Build tool schemas from a tools record. Handles both structured
 * {@link MimicTool}s (Zod-based) and plain functions (introspected).
 */
export function introspectTools(tools: Record<string, ToolInput>): ToolSchema[] {
	return Object.entries(tools).map(([name, t]) => {
		if (isStructuredTool(t)) {
			return {
				name,
				description: t.description,
				parameters: zodSchemaToParameters(t.schema),
			}
		}

		const paramNames = cachedParamNames(t)
		const paramDescriptions = t.params ?? {}
		const parameters: Record<string, string> = {}
		for (const p of paramNames) {
			parameters[p] = paramDescriptions[p] ?? p
		}
		return {
			name,
			description: t.description ?? name,
			parameters,
		}
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
 * Execute a tool by name. For structured tools, validates args against
 * the Zod schema first (with instructive error messages). For plain
 * functions, maps the args record to positional arguments.
 */
export async function executeTool(
	tools: Record<string, ToolInput>,
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	const t = tools[name]
	if (!t) throw new Error(`Tool "${name}" is not registered`)

	if (isStructuredTool(t)) {
		const parsed = t.schema.safeParse(args)
		if (!parsed.success) {
			throw new Error(formatZodError(name, parsed.error))
		}
		const result = await t.run(parsed.data)
		return typeof result === 'string' ? result : JSON.stringify(result)
	}

	const paramNames = cachedParamNames(t)
	const positionalArgs = paramNames.map((p) => args[p])
	const result = await t(...positionalArgs)
	return typeof result === 'string' ? result : JSON.stringify(result)
}
