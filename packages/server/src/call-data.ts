/**
 * Structured per-call data.
 *
 * The compiled prompt is shared by every call that has the same goal and the
 * same *shape* of data (field names, which fields are supplied, valid options
 * and field metadata). The values themselves differ per call and are injected
 * at runtime, so a batch of fifty calls compiles once instead of fifty times.
 *
 * `describeDataShape` is what the prompt cache key and the compiler see;
 * `renderDataBlock` is what the live agent sees.
 */

export type CallData = Record<string, unknown>

export type DataShape =
	| { kind: 'value'; type: 'text' | 'number' | 'boolean' }
	| { kind: 'missing' }
	| { kind: 'constrained'; provided: boolean; validOptions: string[]; metadata: Record<string, unknown> }
	| { kind: 'list'; items: DataShape | null }
	| { kind: 'object'; fields: Record<string, DataShape> }

export function isConstrainedField(value: unknown): value is { value: unknown; validOptions: string[] } {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const obj = value as Record<string, unknown>
	return 'value' in obj && 'validOptions' in obj && Array.isArray(obj.validOptions)
}

function isMissing(value: unknown) {
	return value === null || value === undefined
}

export function describeDataShape(data: CallData | undefined): Record<string, DataShape> | null {
	if (!data || Object.keys(data).length === 0) return null
	return describeObject(data)
}

function describeObject(obj: Record<string, unknown>): Record<string, DataShape> {
	const fields: Record<string, DataShape> = {}
	for (const key of Object.keys(obj).sort()) fields[key] = describeValue(obj[key])
	return fields
}

function describeValue(value: unknown): DataShape {
	if (isMissing(value)) return { kind: 'missing' }
	if (typeof value === 'string') return { kind: 'value', type: 'text' }
	if (typeof value === 'number') return { kind: 'value', type: 'number' }
	if (typeof value === 'boolean') return { kind: 'value', type: 'boolean' }
	if (isConstrainedField(value)) {
		const metadata = Object.fromEntries(
			Object.entries(value).filter(([key]) => key !== 'value' && key !== 'validOptions'),
		)
		return {
			kind: 'constrained',
			provided: !isMissing(value.value),
			validOptions: value.validOptions.map(String),
			metadata,
		}
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return { kind: 'list', items: null }
		const objects = value.filter(
			(item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item),
		)
		if (objects.length === value.length) {
			// Items may omit fields; describe the union so the compiler sees every field a row can carry.
			const merged: Record<string, unknown> = {}
			for (const item of objects) for (const [key, val] of Object.entries(item)) if (!(key in merged)) merged[key] = val
			return { kind: 'list', items: { kind: 'object', fields: describeObject(merged) } }
		}
		return { kind: 'list', items: describeValue(value[0]) }
	}
	if (typeof value === 'object') return { kind: 'object', fields: describeObject(value as Record<string, unknown>) }
	return { kind: 'value', type: 'text' }
}

/**
 * Field-by-field description with values masked, for the goal compiler.
 * "provided" fields hold facts the API caller already knows; "missing" fields
 * were not supplied and may be something to collect on the call.
 */
export function renderDataSchema(data: CallData | undefined): string {
	const shape = describeDataShape(data)
	if (!shape) return 'No structured data provided.'
	return renderShapeFields(shape, '').join('\n')
}

function renderShapeFields(fields: Record<string, DataShape>, indent: string): string[] {
	const lines: string[] = []
	for (const [key, shape] of Object.entries(fields)) lines.push(...renderShape(key, shape, indent))
	return lines
}

function renderShape(key: string, shape: DataShape, indent: string): string[] {
	switch (shape.kind) {
		case 'value':
			return [`${indent}${key}: provided (${shape.type})`]
		case 'missing':
			return [`${indent}${key}: missing`]
		case 'constrained': {
			const details = [`valid options: ${shape.validOptions.join(', ')}`]
			if (Object.keys(shape.metadata).length > 0) details.push(`metadata: ${JSON.stringify(shape.metadata)}`)
			return [`${indent}${key}: ${shape.provided ? 'provided' : 'missing'} (${details.join('; ')})`]
		}
		case 'list':
			if (!shape.items) return [`${indent}${key}: empty list`]
			if (shape.items.kind === 'object') {
				return [`${indent}${key}: list of items, each with:`, ...renderShapeFields(shape.items.fields, `${indent}  `)]
			}
			return [`${indent}${key}: list of ${describeItems(shape.items)}`]
		case 'object':
			return [`${indent}${key}:`, ...renderShapeFields(shape.fields, `${indent}  `)]
	}
}

function describeItems(shape: DataShape): string {
	if (shape.kind === 'value') return `${shape.type} values`
	if (shape.kind === 'constrained') return `constrained values (valid options: ${shape.validOptions.join(', ')})`
	if (shape.kind === 'list') return 'lists'
	return 'values'
}

/** Values rendered for the live agent, wrapped in a `<data>` block. Empty when there is nothing to inject. */
export function renderDataBlock(data: CallData | undefined | null): string {
	if (!data || Object.keys(data).length === 0) return ''
	return ['<data>', normalizeData(data), '</data>'].join('\n')
}

export function normalizeData(data: CallData): string {
	const entries = Object.entries(data)
	if (entries.length === 0) return 'No structured data provided.'

	const sections: string[] = []
	for (const [key, value] of entries) {
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			sections.push(`${key}: ${value}`)
		} else if (isMissing(value)) {
			sections.push(`${key}: MISSING`)
		} else if (isConstrainedField(value)) {
			sections.push(`${key}: ${serializeValue(value, '')}`)
		} else if (Array.isArray(value)) {
			sections.push(`${key}:\n${serializeValue(value, '  ')}`)
		} else if (typeof value === 'object') {
			const lines = serializeObject(value as Record<string, unknown>, '  ')
			sections.push(`${key}:\n${lines.map((line) => `  ${line}`).join('\n')}`)
		} else {
			sections.push(`${key}: ${serializeValue(value, '')}`)
		}
	}
	return sections.join('\n\n')
}

function serializeValue(value: unknown, indent: string): string {
	if (isMissing(value)) return 'MISSING'
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)

	if (isConstrainedField(value)) {
		const display = isMissing(value.value) ? 'MISSING' : String(value.value)
		// Preserve field semantics such as conditions, provenance, and collection
		// instructions alongside the value and options.
		const metadata = Object.fromEntries(
			Object.entries(value).filter(([key]) => key !== 'value' && key !== 'validOptions'),
		)
		const metadataText = Object.keys(metadata).length > 0 ? `; metadata: ${JSON.stringify(metadata)}` : ''
		return `${display} (valid options: ${value.validOptions.join(', ')}${metadataText})`
	}

	if (Array.isArray(value)) {
		if (value.length === 0) return 'none'
		if (value.every((item) => typeof item === 'string' || typeof item === 'number')) return value.join(', ')
		const childIndent = indent + '   '
		return value
			.map((item, i) => {
				if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
					const fields = serializeObject(item as Record<string, unknown>, childIndent)
					const firstLine = fields[0]
					const rest = fields.slice(1)
					return [`${indent}${i + 1}. ${firstLine}`, ...rest.map((line) => `${indent}   ${line}`)].join('\n')
				}
				return `${indent}${i + 1}. ${serializeValue(item, childIndent)}`
			})
			.join('\n')
	}

	if (typeof value === 'object') {
		const lines = serializeObject(value as Record<string, unknown>, indent + '  ')
		return '\n' + lines.map((line) => `${indent}  ${line}`).join('\n')
	}

	return String(value)
}

function serializeObject(obj: Record<string, unknown>, indent: string): string[] {
	return Object.entries(obj).map(([key, val]) => {
		const rendered = serializeValue(val, indent)
		if (rendered.startsWith('\n')) return `${key}:${rendered}`
		return `${key}: ${rendered}`
	})
}
