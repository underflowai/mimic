import { createHash } from 'node:crypto'
import { describeDataShape } from './call-data.js'
import type { GoalToolDefinition } from './goal-compiler.js'

// Bump when compiler instructions or the compiler's runtime input contract changes.
// v3: recipient removed from the compiler input (runtime-injected instead).
// v4: compact caller-facing compiler; runtime owns situational cadence.
// v5: data values masked from the compiler (shape only); runtime injects them per call.
export const compilerRevision = 'voice-prompts-v5'

export interface ApiToolInput {
	name: string
	description: string
	kind?: 'read' | 'write'
	parameters?: Record<string, unknown>
}

/**
 * A tool without a declared `kind` is treated as a read: it runs as soon as
 * the caller's request and its arguments are clear, which is what every
 * integration got before `kind` existed. Writes (anything with side effects)
 * must be declared so the watcher gates them on explicit caller authorization.
 */
export const defaultToolKind = 'read'

export function normalizeCallTools(tools: ApiToolInput[] = []): GoalToolDefinition[] {
	return tools.map((tool) => {
		if (tool.kind !== undefined && tool.kind !== 'read' && tool.kind !== 'write') {
			throw new Error(`Tool "${tool.name}" kind must be read or write`)
		}
		return { ...tool, kind: tool.kind ?? defaultToolKind, parameters: tool.parameters ?? {} }
	})
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/**
 * Everything that shapes the compiled prompt. The recipient is deliberately
 * absent: the compiled prompt is recipient-agnostic and the runtime injects
 * caller details into every turn's context block, so one goal compiles once
 * no matter how many people it is used to call. Likewise only the *shape* of
 * `data` is part of the key (see `describeDataShape`); the values are stored
 * per call and injected at runtime.
 */
export interface PromptConfig {
	goal: string
	voice: string
	context?: string
	data?: Record<string, unknown>
	tools: unknown[]
	results: unknown
	aiDisclosure?: boolean
	ambience?: boolean
	persona?: { systemPrompt: string; agentName?: string }
	webhook?: string
}

export function hashPromptConfig(apiKeyId: string, config: PromptConfig, revision = compilerRevision): string {
	const payload = stableStringify({
		apiKeyId,
		goal: config.goal,
		voice: config.voice,
		context: config.context ?? '',
		dataShape: describeDataShape(config.data),
		tools: config.tools,
		results: config.results,
		aiDisclosure: config.aiDisclosure,
		ambience: config.ambience,
		...(config.persona ? { persona: config.persona } : { compilerRevision: revision }),
		...(config.webhook && { webhook: config.webhook }),
	})
	return createHash('sha256').update(payload).digest('hex')
}
