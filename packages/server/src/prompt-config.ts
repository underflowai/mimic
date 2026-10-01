import { createHash } from 'node:crypto'
import type { GoalRecipient, GoalToolDefinition } from './goal-compiler.js'

// Bump when compiler instructions or the compiler's runtime input contract changes.
export const compilerRevision = 'voice-prompts-v2'

export interface ApiToolInput {
	name: string
	description: string
	kind?: 'read' | 'write'
	parameters?: Record<string, unknown>
}

export function normalizeCallTools(tools: ApiToolInput[] = []): GoalToolDefinition[] {
	return tools.map((tool) => {
		if (tool.kind !== undefined && tool.kind !== 'read' && tool.kind !== 'write') {
			throw new Error(`Tool "${tool.name}" kind must be read or write`)
		}
		return { ...tool, kind: tool.kind ?? 'write', parameters: tool.parameters ?? {} }
	})
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

export interface PromptConfig {
	goal: string
	voice: string
	context?: string
	data?: Record<string, unknown>
	recipient?: GoalRecipient
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
		data: config.data ?? null,
		tools: config.tools,
		results: config.results,
		aiDisclosure: config.aiDisclosure,
		ambience: config.ambience,
		...(config.persona
			? { persona: config.persona }
			: { compilerRevision: revision, recipient: config.recipient ?? null }),
		...(config.webhook && { webhook: config.webhook }),
	})
	return createHash('sha256').update(payload).digest('hex')
}
