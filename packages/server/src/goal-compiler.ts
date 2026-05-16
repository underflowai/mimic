import OpenAI from 'openai'
import { z } from 'zod'

import { loadPrompt, renderPromptTemplate } from '@mimic/engine/src/prompts.js'
import { formatUserDateTime } from '@mimic/engine/src/intelligence/control-block-utils.js'
import type { CallOrchestratorConfig, TurnControlBlockContext } from '@mimic/engine/src/orchestrator.js'
import { arloPersona, auroraPersona } from '@mimic/engine/src/shared/voice-persona.js'

export type GoalVoice = 'female' | 'male'

export interface GoalToolDefinition {
	name: string
	description: string
	kind: 'read' | 'write'
	parameters: Record<string, unknown>
}

export interface GoalRecipient {
	firstName: string
	lastName?: string
}

export type GoalContext = string | Record<string, string>

export type GoalData = Record<string, unknown>

export type GoalResults = Record<string, unknown>

export interface GoalCompilerInput {
	goal: string
	recipient?: GoalRecipient
	context: GoalContext
	data?: GoalData
	tools: GoalToolDefinition[]
	results: GoalResults
	voice: GoalVoice
	aiDisclosure?: boolean
}

export interface CompiledGoal {
	systemPrompt: string
	turnControlBlock?: string
	agentName: string
}

export interface AgentConfig extends CompiledGoal {
	goal: string
	recipient?: GoalRecipient
	voice: GoalVoice
	context: GoalContext
	data?: GoalData
	tools: GoalToolDefinition[]
	results: GoalResults
	aiDisclosure: boolean
}

const compiledGoalSchema = z.object({
	compiledPrompt: z.string().min(1),
	speechTags: z.string().min(1),
	turnControlBlock: z.string().min(1),
	agentName: z.string().min(1),
})

let cachedCompilerPrompt: string | null = null

async function getCompilerPrompt() {
	if (!cachedCompilerPrompt) cachedCompilerPrompt = await loadPrompt('instructions/goal-compiler')
	return cachedCompilerPrompt
}

function defaultAgentName(voice: GoalVoice) {
	return voice === 'male' ? arloPersona.firstName : auroraPersona.firstName
}

function isConstrainedField(value: unknown): value is { value: unknown; validOptions: string[] } {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const obj = value as Record<string, unknown>
	return 'value' in obj && 'validOptions' in obj && Array.isArray(obj.validOptions)
}

function serializeValue(value: unknown, indent: string): string {
	if (value === null || value === undefined) return 'MISSING'
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)

	if (isConstrainedField(value)) {
		const display = value.value === null || value.value === undefined ? 'MISSING' : String(value.value)
		return `${display} (valid options: ${value.validOptions.join(', ')})`
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

function serializeObject(obj: Record<string, unknown>, _indent: string): string[] {
	return Object.entries(obj).map(([key, val]) => {
		const rendered = serializeValue(val, _indent)
		if (rendered.startsWith('\n')) return `${key}:${rendered}`
		return `${key}: ${rendered}`
	})
}

function normalizeContext(context: GoalContext): string {
	if (typeof context === 'string') return context
	const entries = Object.entries(context)
	if (entries.length === 0) return 'No additional context provided.'
	return entries.map(([key, value]) => `${key}: ${value}`).join('\n')
}

function normalizeData(data: GoalData): string {
	const entries = Object.entries(data)
	if (entries.length === 0) return 'No structured data provided.'

	const sections: string[] = []
	for (const [key, value] of entries) {
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			sections.push(`${key}: ${value}`)
		} else if (value === null || value === undefined) {
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

function formatObjectBlock(value: Record<string, unknown>) {
	const entries = Object.entries(value)
	if (entries.length === 0) return 'None provided.'
	return entries
		.map(([key, item]) => {
			const formatted = typeof item === 'string' ? item : JSON.stringify(item)
			return `- ${key}: ${formatted}`
		})
		.join('\n')
}

function formatTools(tools: GoalToolDefinition[]) {
	if (tools.length === 0) return 'No tools provided.'
	return tools
		.map((tool) =>
			[
				`- ${tool.name} (${tool.kind}): ${tool.description}`,
				`  Parameters: ${Object.keys(tool.parameters).length > 0 ? JSON.stringify(tool.parameters) : 'none'}`,
			].join('\n'),
		)
		.join('\n')
}

function buildCompilerInput(input: GoalCompilerInput) {
	const parts = [
		`Voice: ${input.voice}`,
		`Default agent name: ${defaultAgentName(input.voice)}`,
		`Recipient: ${
			input.recipient
				? `${input.recipient.firstName}${input.recipient.lastName ? ' ' + input.recipient.lastName : ''}`
				: 'Unknown caller; runtime may provide caller details in the control block.'
		}`,
		`AI disclosure: ${input.aiDisclosure !== false ? 'yes — disclose AI status and recording in opening' : 'no — do NOT mention being AI or recording'}`,
		'',
		'Goal:',
		input.goal,
		'',
		'Context:',
		normalizeContext(input.context),
	]
	if (input.data && Object.keys(input.data).length > 0) {
		parts.push('', 'Structured data (to confirm/collect):', normalizeData(input.data))
	}
	parts.push('', 'Tools available:', formatTools(input.tools))
	parts.push('', 'Results (what to extract/collect):', formatObjectBlock(input.results))
	return parts.join('\n')
}

async function renderSystemPromptFromTemplate(
	agentName: string,
	compiled: z.infer<typeof compiledGoalSchema>,
): Promise<string> {
	return renderPromptTemplate('voice-api-template', {
		agentName,
		compiledPrompt: compiled.compiledPrompt,
		speechTags: compiled.speechTags,
	})
}

export async function compileGoal(input: GoalCompilerInput): Promise<CompiledGoal> {
	const compilerPrompt = await getCompilerPrompt()
	const openai = new OpenAI()

	const result = await openai.chat.completions.create({
		model: 'gpt-5.4',
		temperature: 0,
		max_completion_tokens: 8000,
		response_format: { type: 'json_object' },
		messages: [
			{ role: 'system', content: compilerPrompt },
			{ role: 'user', content: buildCompilerInput(input) },
		],
	})

	const raw = result.choices[0]?.message?.content?.trim() ?? ''
	const parsed = compiledGoalSchema.parse(JSON.parse(raw))

	const agentName = parsed.agentName || defaultAgentName(input.voice)
	const systemPrompt = await renderSystemPromptFromTemplate(agentName, parsed)

	// Store the prompt with [AGENT_NAME] placeholder so it can be reused
	// across voices without recompilation
	const templatePrompt = systemPrompt.replaceAll(agentName, '[AGENT_NAME]')

	return {
		systemPrompt: templatePrompt,
		turnControlBlock: parsed.turnControlBlock,
		agentName,
	}
}

function resolveFirstName(agent: AgentConfig, callContext?: Record<string, string>) {
	return callContext?.firstName ?? agent.recipient?.firstName ?? ''
}

function resolveRecipient(agent: AgentConfig, callContext?: Record<string, string>) {
	const firstName = callContext?.firstName ?? agent.recipient?.firstName
	const lastName = callContext?.lastName ?? agent.recipient?.lastName
	const email = callContext?.email
	if (!firstName && !lastName && !email) return undefined
	return { firstName, lastName, email }
}

function buildOpeningContextBlock(userTimezone?: string, recipient?: ReturnType<typeof resolveRecipient>) {
	const parts: string[] = ['<context>']
	parts.push(`now: ${formatUserDateTime(userTimezone)}`)
	if (recipient?.firstName) parts.push(`callerFirstName: ${recipient.firstName}`)
	if (recipient?.lastName) parts.push(`callerLastName: ${recipient.lastName}`)
	if (recipient?.email) parts.push(`callerEmail: ${recipient.email}`)
	parts.push('</context>')
	return parts.join('\n')
}

function buildTurnControlBlock(ctx: TurnControlBlockContext) {
	const hasToolResults = ctx.toolResults && ctx.toolResults.length > 0

	const sections: string[] = []

	const lateParts = ['<context>']
	lateParts.push(`now: ${formatUserDateTime(ctx.userTimezone)}`)
	if (ctx.recipient?.firstName) lateParts.push(`callerFirstName: ${ctx.recipient.firstName}`)
	if (ctx.recipient?.lastName) lateParts.push(`callerLastName: ${ctx.recipient.lastName}`)
	if (ctx.recipient?.email) lateParts.push(`callerEmail: ${ctx.recipient.email}`)
	lateParts.push('</context>')
	sections.push(lateParts.join('\n'))

	if (hasToolResults) {
		sections.push('<tool_results>')
		for (const r of ctx.toolResults!) {
			sections.push(`[${r.topic}]\n${r.result}`)
		}
		sections.push('</tool_results>')
	}

	return sections.join('\n')
}

export function buildOrchestratorConfigFromAgent(
	agent: AgentConfig,
	callContext?: Record<string, string>,
): { orchestratorConfig: Omit<CallOrchestratorConfig, 'audioTransport'> } {
	const persona = agent.voice === 'male' ? arloPersona : auroraPersona
	const userTimezone = callContext?.userTimezone
	const recipient = resolveRecipient(agent, callContext)
	return {
		orchestratorConfig: {
			persona,
			systemPrompt: agent.systemPrompt.replaceAll('[AGENT_NAME]', persona.firstName),
			maxCompletionTokens: 384,
			userFirstName: resolveFirstName(agent, callContext),
			recipient,
			buildOpeningBlock: () => buildOpeningContextBlock(userTimezone, recipient),
			buildTurnControlBlock,
			textQualityBlock: agent.turnControlBlock ?? undefined,
			tools: agent.tools.length > 0 ? agent.tools : undefined,
		},
	}
}
