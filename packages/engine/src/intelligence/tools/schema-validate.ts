/**
 * Deterministic tool-argument validation against the JSON Schema that
 * ships with each tool definition.
 *
 * The watcher's structured output forces every extracted argument to a
 * string, so validation doubles as coercion: "3" becomes 3 for a
 * number-typed parameter, "true" becomes true for a boolean. Tools whose
 * `parameters` are not a JSON Schema object (nothing to check against)
 * pass through untouched.
 */

export interface ArgValidationResult {
	ok: boolean
	/** Args with schema-directed coercions applied. */
	args: Record<string, unknown>
	errors: string[]
}

interface JsonSchemaProperty {
	type?: string | string[]
	description?: string
	enum?: unknown[]
	[key: string]: unknown
}

interface JsonSchemaObject {
	type?: string
	properties: Record<string, JsonSchemaProperty>
	required?: string[]
	additionalProperties?: boolean | Record<string, unknown>
}

export function isJsonSchemaObject(parameters: Record<string, unknown>): parameters is Record<string, unknown> & JsonSchemaObject {
	if (typeof parameters !== 'object' || parameters === null) return false
	const props = (parameters as { properties?: unknown }).properties
	if (typeof props !== 'object' || props === null) return false
	return Object.values(props as Record<string, unknown>).every((p) => typeof p === 'object' && p !== null)
}

function primaryType(prop: JsonSchemaProperty): string | null {
	if (typeof prop.type === 'string') return prop.type
	if (Array.isArray(prop.type)) {
		const first = prop.type.find((t) => t !== 'null')
		return typeof first === 'string' ? first : null
	}
	return null
}

function coerceValue(value: unknown, type: string | null): { value: unknown; error: string | null } {
	if (value === null || value === undefined || type === null) return { value, error: null }

	switch (type) {
		case 'number':
		case 'integer': {
			if (typeof value === 'number') return { value, error: null }
			if (typeof value === 'string' && value.trim() !== '') {
				const parsed = Number(value)
				if (!Number.isNaN(parsed)) return { value: type === 'integer' ? Math.trunc(parsed) : parsed, error: null }
			}
			return { value, error: `expected ${type}, got ${JSON.stringify(value)}` }
		}
		case 'boolean': {
			if (typeof value === 'boolean') return { value, error: null }
			if (typeof value === 'string') {
				const lowered = value.trim().toLowerCase()
				if (lowered === 'true' || lowered === 'yes') return { value: true, error: null }
				if (lowered === 'false' || lowered === 'no') return { value: false, error: null }
			}
			return { value, error: `expected boolean, got ${JSON.stringify(value)}` }
		}
		case 'string': {
			if (typeof value === 'string') return { value, error: null }
			if (typeof value === 'number' || typeof value === 'boolean') return { value: String(value), error: null }
			return { value, error: `expected string, got ${JSON.stringify(value)}` }
		}
		case 'array': {
			if (Array.isArray(value)) return { value, error: null }
			if (typeof value === 'string') {
				try {
					const parsed = JSON.parse(value)
					if (Array.isArray(parsed)) return { value: parsed, error: null }
				} catch {
					// fall through — treat a plain string as a single-element array
				}
				return { value: [value], error: null }
			}
			return { value, error: `expected array, got ${JSON.stringify(value)}` }
		}
		case 'object': {
			if (typeof value === 'object' && !Array.isArray(value)) return { value, error: null }
			if (typeof value === 'string') {
				try {
					const parsed = JSON.parse(value)
					if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return { value: parsed, error: null }
				} catch {
					// not JSON
				}
			}
			return { value, error: `expected object, got ${JSON.stringify(value)}` }
		}
		default:
			return { value, error: null }
	}
}

export function validateToolArgs(
	parameters: Record<string, unknown>,
	args: Record<string, unknown>,
): ArgValidationResult {
	if (!isJsonSchemaObject(parameters)) {
		return { ok: true, args, errors: [] }
	}

	const schema = parameters
	const errors: string[] = []
	const coerced: Record<string, unknown> = {}

	for (const [key, rawValue] of Object.entries(args)) {
		if (rawValue === null || rawValue === undefined) continue
		const prop = schema.properties[key]
		if (!prop) {
			if (schema.additionalProperties === false) {
				errors.push(`unknown parameter "${key}"`)
			} else {
				coerced[key] = rawValue
			}
			continue
		}
		const { value, error } = coerceValue(rawValue, primaryType(prop))
		if (error) {
			errors.push(`${key}: ${error}`)
			continue
		}
		if (Array.isArray(prop.enum) && prop.enum.length > 0 && !prop.enum.some((option) => option === value)) {
			errors.push(`${key}: ${JSON.stringify(value)} is not one of ${prop.enum.map((o) => JSON.stringify(o)).join(', ')}`)
			continue
		}
		coerced[key] = value
	}

	for (const key of schema.required ?? []) {
		if (coerced[key] === undefined) {
			errors.push(`missing required parameter "${key}"`)
		}
	}

	return { ok: errors.length === 0, args: coerced, errors }
}
