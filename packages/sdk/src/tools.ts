import type { ToolFunction, ToolSchema } from './types.js'

/**
 * Extract parameter names from a function by parsing its source.
 *
 * Handles:
 *   - Named functions: `function foo(a, b) {}`
 *   - Arrow functions: `(a, b) => ...` or `a => ...`
 *   - Methods: `{ foo(a, b) {} }`
 *   - Destructured defaults: strips `= ...` and `{ ... }` wrappers
 */
export function parseParameterNames(fn: Function): string[] {
	const source = fn.toString()

	// Single-param arrows without parens: `x => ...`
	const arrowMatch = source.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/)
	if (arrowMatch) return [arrowMatch[1]!]

	// Find the first `(` and its balanced closing `)`.
	// Can't use a simple regex since default values may contain nested parens.
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

/**
 * Parse a comma-separated parameter string into clean names.
 * Handles rest params, defaults, destructuring, and type annotations.
 */
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

/** Extract a clean parameter name from a single param declaration. */
function cleanParam(raw: string): string | null {
	let s = raw.trim()
	if (!s) return null

	// Strip rest operator
	if (s.startsWith('...')) s = s.slice(3).trim()

	// Strip default value (`param = defaultValue`)
	const eqIdx = s.indexOf('=')
	if (eqIdx > 0) s = s.slice(0, eqIdx).trim()

	// Strip TS type annotation (`param: Type`) — only if there's no destructuring
	if (!s.startsWith('{') && !s.startsWith('[')) {
		const colonIdx = s.indexOf(':')
		if (colonIdx > 0) s = s.slice(0, colonIdx).trim()
	}

	// If destructured, use a generic name
	if (s.startsWith('{') || s.startsWith('[')) return null

	// Validate it looks like an identifier
	if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s)) return s

	return null
}

/**
 * Introspect a record of functions into tool schemas for the API.
 *
 * The function name becomes the tool name. Parameter names are extracted
 * from the function source. An optional `.description` property on the
 * function provides the tool description; otherwise the name is used.
 */
export function introspectTools(tools: Record<string, ToolFunction>): ToolSchema[] {
	return Object.entries(tools).map(([name, fn]) => ({
		name,
		description: fn.description ?? name,
		parameters: parseParameterNames(fn),
	}))
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

/**
 * Execute a tool function by name, converting the args map to positional arguments.
 *
 * @returns The stringified result.
 * @throws If the tool is not registered or the function throws.
 */
export async function executeTool(
	tools: Record<string, ToolFunction>,
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	const fn = tools[name]
	if (!fn) throw new Error(`Tool "${name}" is not registered`)

	const paramNames = cachedParamNames(fn)
	const positionalArgs = paramNames.map((p) => args[p])

	const result = await fn(...positionalArgs)
	return typeof result === 'string' ? result : JSON.stringify(result)
}
