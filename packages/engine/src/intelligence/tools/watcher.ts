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
}

const watcherDecisionSchema = z.object({
	decision: z.enum(['execute', 'not_ready', 'none']),
	tool: z.string().nullable().optional().default(null),
	args: z.record(z.unknown()).nullable().optional().default(null),
	missing: z.array(z.string()).nullable().optional().default(null),
	directorNote: z.string().nullable().optional().default(null),
	reasoning: z.string().optional().default(''),
})

export interface ToolWatcherInput {
	transcript: string
	recentTurns: CallTurn[]
	tools: ToolDefinition[]
	priorToolResults?: Array<{ toolName: string; result: string }>
	existingToolName?: string
	existingToolArgs?: Record<string, unknown>
	signal?: AbortSignal
}

let cachedPrompt: Promise<string> | null = null
function getSystemPrompt() {
	cachedPrompt ??= loadPrompt('instructions/tool-watcher')
	return cachedPrompt
}

function formatToolSchemas(tools: ToolDefinition[]): string {
	return tools
		.map((t) => {
			const kindLabel = t.kind === 'write' ? ' [WRITE]' : ' [READ]'
			const params =
				typeof t.parameters === 'object' && t.parameters !== null && 'properties' in t.parameters
					? Object.entries((t.parameters as { properties: Record<string, unknown> }).properties)
							.map(([key, schema]) => {
								const desc =
									typeof schema === 'object' && schema !== null && 'description' in schema
										? (schema as { description: string }).description
										: ''
								return `    ${key}: ${desc || typeof schema}`
							})
							.join('\n')
					: Object.entries(t.parameters)
							.map(([key, desc]) => `    ${key}: ${desc}`)
							.join('\n')
			return `- ${t.name}${kindLabel}: ${t.description}\n  Parameters:\n${params}`
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
}

function buildArgsSchemaForTools(tools: ToolDefinition[]) {
	if (tools.length === 0) return { type: 'object' as const, additionalProperties: false as const }
	if (tools.length === 1) {
		const tool = tools[0]
		const params = tool.parameters
		if (typeof params === 'object' && params !== null && 'properties' in params) {
			const props: Record<string, unknown> = {}
			for (const [key, schema] of Object.entries((params as { properties: Record<string, unknown> }).properties)) {
				props[key] =
					typeof schema === 'object' && schema !== null
						? { ...(schema as object), type: ['string', 'null'] }
						: { type: ['string', 'null'] }
			}
			return {
				type: 'object' as const,
				properties: props,
				required: Object.keys(props),
				additionalProperties: false as const,
			}
		}
	}
	const allProps: Record<string, unknown> = {}
	const duplicateKeys = new Set<string>()
	for (const tool of tools) {
		const params = tool.parameters
		if (typeof params === 'object' && params !== null && 'properties' in params) {
			for (const [key, schema] of Object.entries((params as { properties: Record<string, unknown> }).properties)) {
				if (key in allProps) {
					duplicateKeys.add(key)
					continue
				}
				allProps[key] =
					typeof schema === 'object' && schema !== null
						? { ...(schema as object), type: ['string', 'null'] }
						: { type: ['string', 'null'] }
			}
		}
	}
	if (duplicateKeys.size > 0) {
		// Colliding keys share one nullable-string slot; the model picks by tool name.
		// A permissive `additionalProperties` schema is rejected by strict mode, so stay strict.
		log.warn(
			{ duplicateKeys: Array.from(duplicateKeys.values()) },
			'tool watcher arg names collide across tools; sharing arg slots',
		)
	}
	// Strict mode requires every property to be listed in `required`; nullability is how the
	// model leaves an arg unset.
	return {
		type: 'object' as const,
		properties: allProps,
		required: Object.keys(allProps),
		additionalProperties: false as const,
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
				},
				required: ['decision', 'tool', 'args', 'missing', 'directorNote', 'reasoning'],
				additionalProperties: false,
			},
		},
	}
}

export async function watchForToolAction(client: OpenAI, input: ToolWatcherInput): Promise<WatcherDecision> {
	const systemPrompt = await getSystemPrompt()
	const conversation = formatTurnsForPrompt(input.recentTurns.slice(-10))

	const userParts: string[] = []
	userParts.push('## Available tools\n' + formatToolSchemas(input.tools))
	if (input.existingToolName && input.existingToolArgs) {
		const argsStr = Object.entries(input.existingToolArgs)
			.filter(([, v]) => v != null && v !== '')
			.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
			.join('\n')
		userParts.push(
			`\n## Tool already in progress\nTool: ${input.existingToolName}\nArgs collected so far:\n${argsStr || '  (none yet)'}`,
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
		const parsed = parsedResult.data
		if (parsed.args) {
			// Every arg is required-but-nullable in the strict schema; drop the nulls so unset
			// args don't overwrite values collected on earlier turns.
			parsed.args = Object.fromEntries(Object.entries(parsed.args).filter(([, v]) => v != null))
		}
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
