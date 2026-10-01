/**
 * Tool Watcher — background LLM that decides if/when to execute a tool.
 *
 * Runs `models.toolWatcher` through the Responses API with a strict JSON
 * schema for intent detection and arg extraction. Returns:
 *   - execute: all required args are present, fire the tool
 *   - not_ready: tool is relevant but args are missing
 *   - none: no tool action needed
 */

import type OpenAI from 'openai'
import { z } from 'zod'

import { config } from '#engine/config.js'
import { createLogger } from '#engine/logger.js'
import { models } from '#engine/models.js'
import { loadPrompt } from '#engine/prompts.js'

import { formatTurnsForPrompt, type CallTurn } from '../../shared/prompt-turns.js'
import type { ToolDefinition } from './runner.js'

const log = createLogger('mimic:tool-watcher')

export interface WatcherDecision {
	decision: 'execute' | 'not_ready' | 'none'
	tool: string | null
	args: Record<string, unknown> | null
	missing: string[] | null
	directorNote: string | null
	reasoning: string
	/** Explicit caller withdrawal of the existing pending tool, never a running-tool cancellation. */
	cancelExisting?: boolean
}

const watcherDecisionSchema = z.object({
	decision: z.enum(['execute', 'not_ready', 'none']),
	tool: z.string().nullable().optional().default(null),
	args: z.record(z.unknown()).nullable().optional().default(null),
	missing: z.array(z.string()).nullable().optional().default(null),
	directorNote: z.string().nullable().optional().default(null),
	reasoning: z.string().optional().default(''),
	writeAuthorizationQuote: z.string().nullable().optional().default(null),
	cancelExisting: z.boolean().optional().default(false),
})

export interface ToolWatcherInput {
	transcript: string
	recentTurns: CallTurn[]
	tools: ToolDefinition[]
	priorToolResults?: Array<{ toolName: string; result: string }>
	existingToolName?: string
	existingToolArgs?: Record<string, unknown>
	callerDateTime?: string
	signal?: AbortSignal
}

let cachedPrompt: Promise<string> | null = null
function getSystemPrompt() {
	cachedPrompt ??= loadPrompt('instructions/tool-watcher')
	return cachedPrompt
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Inline local references before moving parameter schemas into the response root. */
function resolveLocalSchemaReferences(root: Record<string, unknown>): Record<string, unknown> {
	let visited = 0
	function visit(value: unknown, resolving: Set<string>, depth: number): unknown {
		if (++visited > 10_000 || depth > 64) throw new Error('schema reference expansion exceeds the supported size')
		if (!isRecord(value)) return value
		let referenced: Record<string, unknown> = {}
		if ('$ref' in value) {
			if (typeof value.$ref !== 'string' || !value.$ref.startsWith('#')) {
				throw new Error('external schema references are unsupported; use local nonrecursive references')
			}
			const reference = decodeURIComponent(value.$ref.slice(1))
			if (reference !== '' && !reference.startsWith('/')) {
				throw new Error('schema anchors are unsupported; use local JSON Pointer references')
			}
			if (resolving.has(reference)) throw new Error('recursive schema references are unsupported')
			let target: unknown = root
			for (const part of reference === '' ? [] : reference.slice(1).split('/')) {
				const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
				if ((!isRecord(target) && !Array.isArray(target)) || !Object.hasOwn(target, key)) {
					throw new Error(`unresolved local schema reference: #${reference}`)
				}
				target = (target as Record<string, unknown>)[key]
			}
			if (!isRecord(target)) throw new Error('schema references must resolve to an object schema')
			referenced = visit(target, new Set([...resolving, reference]), depth + 1) as Record<string, unknown>
		}

		const own: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(value)) {
			// Definitions are not validation constraints. All used references are now
			// inlined, and leaving unused recursive definitions would defeat that work.
			if (key === '$ref' || key === '$defs' || key === 'definitions') continue
			if (['properties', 'patternProperties', 'dependentSchemas'].includes(key) && isRecord(child)) {
				own[key] = Object.fromEntries(
					Object.entries(child).map(([name, schema]) => [name, visit(schema, resolving, depth + 1)]),
				)
			} else if (['anyOf', 'oneOf', 'allOf', 'prefixItems'].includes(key) && Array.isArray(child)) {
				own[key] = child.map((schema) => visit(schema, resolving, depth + 1))
			} else if (key === 'items' && Array.isArray(child)) {
				own[key] = child.map((schema) => visit(schema, resolving, depth + 1))
			} else if (
				[
					'items',
					'additionalProperties',
					'additionalItems',
					'contains',
					'propertyNames',
					'not',
					'if',
					'then',
					'else',
					'unevaluatedProperties',
					'unevaluatedItems',
				].includes(key)
			) {
				own[key] = visit(child, resolving, depth + 1)
			} else {
				// Do not interpret example, enum, or default values as schemas.
				own[key] = child
			}
		}
		for (const [key, child] of Object.entries(own)) {
			if (!(key in referenced) || ['description', 'title', 'default', 'examples', '$comment'].includes(key)) {
				referenced[key] = child
			} else if (key === 'required' && Array.isArray(referenced[key]) && Array.isArray(child)) {
				referenced[key] = [...new Set([...referenced[key], ...child])]
			} else if (JSON.stringify(referenced[key]) !== JSON.stringify(child)) {
				// Overwriting sibling constraints would weaken the schema. Avoid an
				// unsupported allOf rewrite and fail explicitly instead.
				throw new Error(`conflicting ${key} constraints beside a schema reference are unsupported`)
			}
		}
		return referenced
	}
	return visit(root, new Set(), 0) as Record<string, unknown>
}

function parameterProperties(tool: ToolDefinition): Record<string, unknown> {
	if (isRecord(tool.parameters.properties)) return tool.parameters.properties
	if (tool.parameters.type === 'object') return {}
	// Legacy tool definitions use { parameterName: description }.
	return Object.fromEntries(
		Object.entries(tool.parameters).map(([name, description]) => [name, { type: 'string', description }]),
	)
}

function requiredParameters(tool: ToolDefinition): string[] {
	return Array.isArray(tool.parameters.required)
		? tool.parameters.required.filter((name): name is string => typeof name === 'string')
		: 'properties' in tool.parameters || tool.parameters.type === 'object'
			? []
			: Object.keys(tool.parameters)
}

function formatToolSchemas(tools: ToolDefinition[]): string {
	return tools
		.map((tool) => {
			const kindLabel = tool.kind === 'write' ? '[WRITE]' : '[READ]'
			return `- ${tool.name} ${kindLabel}: ${tool.description}\n  Parameters: ${JSON.stringify({
				type: 'object',
				properties: parameterProperties(tool),
				required: requiredParameters(tool),
			})}`
		})
		.join('\n')
}

const FALLBACK: WatcherDecision = {
	decision: 'none',
	tool: null,
	args: null,
	missing: null,
	directorNote: null,
	reasoning: 'watcher returned no parseable result',
	cancelExisting: false,
}

/** Preserve declared argument types; strict output uses null for an unset slot. */
function strictParameterSchema(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return { type: 'string' }
	const schema = { ...value }
	delete schema.default
	if (isRecord(schema.properties)) {
		const required = Array.isArray(schema.required) ? schema.required : []
		schema.properties = Object.fromEntries(
			Object.entries(schema.properties).map(([key, property]) => {
				const strict = strictParameterSchema(property)
				return [key, required.includes(key) ? strict : { anyOf: [strict, { type: 'null' }] }]
			}),
		)
		schema.required = Object.keys(schema.properties as object)
		schema.additionalProperties = false
	}
	if (isRecord(schema.items)) schema.items = strictParameterSchema(schema.items)
	for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
		if (Array.isArray(schema[keyword])) schema[keyword] = schema[keyword].map(strictParameterSchema)
	}
	return schema
}

function buildArgsSchemaForTools(tools: ToolDefinition[]) {
	const variants = new Map<string, Record<string, unknown>[]>()
	for (const tool of tools) {
		for (const [name, schema] of Object.entries(parameterProperties(tool))) {
			const strict = strictParameterSchema(schema)
			const existing = variants.get(name) ?? []
			if (!existing.some((item) => JSON.stringify(item) === JSON.stringify(strict))) existing.push(strict)
			variants.set(name, existing)
		}
	}
	const properties = Object.fromEntries(
		Array.from(variants, ([name, schemas]) => [name, { anyOf: [...schemas, { type: 'null' }] }]),
	)
	return {
		type: 'object' as const,
		properties,
		required: Object.keys(properties),
		additionalProperties: false as const,
	}
}

// Check the selected tool's types even when a shared output slot permits another
// tool's type. This is a shape check, not a replacement for tool-side validation.
function matchesParameterSchema(value: unknown, schema: unknown): boolean {
	if (!isRecord(schema)) return true
	if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value)))
		return false
	if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false
	if (Array.isArray(schema.anyOf) && !schema.anyOf.some((item) => matchesParameterSchema(value, item))) return false
	if (Array.isArray(schema.oneOf) && schema.oneOf.filter((item) => matchesParameterSchema(value, item)).length !== 1)
		return false
	if (Array.isArray(schema.allOf) && !schema.allOf.every((item) => matchesParameterSchema(value, item))) return false
	const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
	if (
		types.length &&
		!types.some((type) => {
			if (type === 'null') return value === null
			if (type === 'array') return Array.isArray(value)
			if (type === 'object') return isRecord(value)
			if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
			return typeof value === type
		})
	)
		return false
	if (Array.isArray(value) && schema.items) return value.every((item) => matchesParameterSchema(item, schema.items))
	if (isRecord(value) && isRecord(schema.properties)) {
		const properties = schema.properties
		if (Array.isArray(schema.required) && schema.required.some((key) => typeof key === 'string' && !(key in value)))
			return false
		return Object.entries(value).every(
			([key, item]) =>
				(key in properties || schema.additionalProperties !== false) && matchesParameterSchema(item, properties[key]),
		)
	}
	return true
}

function removeUnsetOptionalFields(value: unknown, schema: unknown): unknown {
	if (!isRecord(schema)) return value
	for (const keyword of ['anyOf', 'oneOf']) {
		if (!Array.isArray(schema[keyword])) continue
		for (const branch of schema[keyword]) {
			const normalized = removeUnsetOptionalFields(value, branch)
			if (matchesParameterSchema(normalized, branch)) return normalized
		}
	}
	if (Array.isArray(schema.allOf)) {
		value = schema.allOf.reduce((current, branch) => removeUnsetOptionalFields(current, branch), value)
	}
	if (Array.isArray(value)) return value.map((item) => removeUnsetOptionalFields(item, schema.items))
	if (!isRecord(value) || !isRecord(schema.properties)) return value
	const properties = schema.properties
	const required = Array.isArray(schema.required) ? schema.required : []
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key, item]) => item !== null || required.includes(key))
			.map(([key, item]) => [key, removeUnsetOptionalFields(item, properties[key])]),
	)
}

function normalizeDecision(parsed: z.infer<typeof watcherDecisionSchema>, input: ToolWatcherInput): WatcherDecision {
	if (parsed.decision === 'none') {
		return {
			...FALLBACK,
			reasoning: parsed.reasoning,
			cancelExisting: Boolean(input.existingToolName && parsed.cancelExisting),
		}
	}
	const tool = input.tools.find((candidate) => candidate.name === parsed.tool)
	if (!tool) return { ...FALLBACK, reasoning: 'watcher selected an unavailable tool' }
	const properties = parameterProperties(tool)
	const args: Record<string, unknown> = {}
	const missing = new Set(parsed.missing ?? [])
	const collected = input.existingToolName === tool.name ? input.existingToolArgs : undefined
	const supplied = Object.fromEntries(Object.entries(parsed.args ?? {}).filter(([, value]) => value != null))
	for (const [key, value] of Object.entries({ ...collected, ...supplied })) {
		if (!(key in properties) || value == null) continue
		const normalized = removeUnsetOptionalFields(value, properties[key])
		if (matchesParameterSchema(normalized, properties[key])) args[key] = normalized
		else missing.add(key)
	}
	for (const key of requiredParameters(tool)) {
		if (!(key in args) || (typeof args[key] === 'string' && !(args[key] as string).trim())) missing.add(key)
	}
	if (tool.kind === 'write') {
		const quote = parsed.writeAuthorizationQuote?.trim()
		const callerStatements = [
			input.transcript,
			...input.recentTurns.filter((turn) => turn.role === 'user').map((turn) => turn.content),
		]
		if (!quote || !callerStatements.some((statement) => statement.trim() === quote)) missing.add('authorization')
	}
	// Invocation readiness is based on missing.length, so not_ready must retain a
	// blocker even if the model forgot to identify it.
	if (parsed.decision === 'not_ready' && missing.size === 0) missing.add('requirements_unresolved')
	const blocked = missing.size > 0
	return {
		decision: blocked ? 'not_ready' : 'execute',
		tool: tool.name,
		args,
		missing: blocked ? Array.from(missing) : null,
		directorNote:
			blocked && parsed.decision === 'execute'
				? `${tool.name} needs: ${Array.from(missing).join(', ')}.`
				: parsed.directorNote,
		reasoning: parsed.reasoning,
		cancelExisting: false,
	}
}

function buildResponseSchema(tools: ToolDefinition[]) {
	const argsSchema = buildArgsSchemaForTools(tools)
	return {
		type: 'json_schema' as const,
		json_schema: {
			name: 'watcher_decision',
			strict: true,
			schema: {
				type: 'object',
				properties: {
					decision: { type: 'string', enum: ['execute', 'not_ready', 'none'] },
					tool: { type: ['string', 'null'] },
					args: {
						anyOf: [argsSchema, { type: 'null' }],
					},
					missing: { type: ['array', 'null'], items: { type: 'string' } },
					directorNote: { type: ['string', 'null'] },
					reasoning: { type: 'string' },
					writeAuthorizationQuote: { type: ['string', 'null'] },
					cancelExisting: { type: 'boolean' },
				},
				required: [
					'decision',
					'tool',
					'args',
					'missing',
					'directorNote',
					'reasoning',
					'writeAuthorizationQuote',
					'cancelExisting',
				],
				additionalProperties: false,
			},
		},
	}
}

export async function watchForToolAction(client: OpenAI, input: ToolWatcherInput): Promise<WatcherDecision> {
	if (input.signal?.aborted) return FALLBACK
	try {
		input = {
			...input,
			tools: input.tools.map((tool) => {
				try {
					return { ...tool, parameters: resolveLocalSchemaReferences(tool.parameters) }
				} catch (err) {
					throw new Error(`Tool ${tool.name}: ${err instanceof Error ? err.message : 'unsupported parameter schema'}`)
				}
			}),
		}
	} catch (err) {
		const reason = err instanceof Error ? err.message : 'unsupported parameter schema'
		log.warn({ reason }, 'tool watcher cannot use configured schema')
		return {
			...FALLBACK,
			reasoning: reason,
			directorNote: 'A tool cannot run because its parameter schema needs correction.',
		}
	}
	const systemPrompt = await getSystemPrompt()
	const conversation = formatTurnsForPrompt(input.recentTurns)

	const now = input.callerDateTime || `${new Date().toISOString()} (UTC fallback; caller timezone unknown)`
	const userParts: string[] = [`## Current date/time\n${now}`]
	userParts.push('## Available tools\n' + formatToolSchemas(input.tools))
	if (input.existingToolName && input.existingToolArgs) {
		const argsStr = Object.entries(input.existingToolArgs)
			.filter(([, v]) => v != null && v !== '')
			.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
			.join('\n')
		userParts.push(
			`\n## Pending tool awaiting input\nTool: ${input.existingToolName}\nArgs collected so far:\n${argsStr || '  (none yet)'}`,
		)
	}
	if (input.priorToolResults?.length) {
		const resultsBlock = input.priorToolResults.map((r) => `${r.toolName}: ${r.result}`).join('\n')
		userParts.push('\n## Prior tool results\n' + resultsBlock)
	}
	if (conversation) userParts.push('\n## Conversation so far\n' + conversation)
	userParts.push(`\n## Caller just said\n"${input.transcript}"`)

	const responseSchema = buildResponseSchema(input.tools)

	try {
		const watcher = models.toolWatcher
		const timeout = config.mimic.timeouts.toolWatcherMs
		const response = (await client.responses.create(
			{
				model: watcher.model,
				max_output_tokens: watcher.maxOutputTokens,
				reasoning: { effort: watcher.reasoningEffort },
				instructions: systemPrompt,
				input: userParts.join('\n'),
				text: { format: { type: 'json_schema', ...responseSchema.json_schema } },
				stream: false,
			} as Parameters<typeof client.responses.create>[0],
			input.signal ? { signal: input.signal, timeout } : { timeout },
		)) as OpenAI.Responses.Response

		const textBlock = response.output.find((b: { type: string }) => b.type === 'message')
		const content =
			textBlock && 'content' in textBlock
				? (textBlock.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'output_text')?.text
				: null
		if (!content) {
			log.warn('watcher returned empty content')
			return FALLBACK
		}

		const parsedRaw = JSON.parse(content)
		const parsedResult = watcherDecisionSchema.safeParse(parsedRaw)
		if (!parsedResult.success) {
			log.warn({ issues: parsedResult.error.issues }, 'watcher returned invalid schema')
			return FALLBACK
		}
		if (input.signal?.aborted) return FALLBACK
		const parsed = normalizeDecision(parsedResult.data, input)
		log.info(
			{ decision: parsed.decision, tool: parsed.tool, directorNote: parsed.directorNote, reasoning: parsed.reasoning },
			'watcher decision',
		)
		return parsed
	} catch (err) {
		if (input.signal?.aborted) return FALLBACK
		log.error({ err }, 'tool watcher failed')
		return FALLBACK
	}
}
