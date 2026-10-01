import OpenAI from 'openai'
import { zodResponseFormat } from 'openai/helpers/zod'
import { z } from 'zod'

import {
	arloPersona,
	auroraPersona,
	defaultMimicTools,
	formatUserDateTime,
	loadPrompt,
	models,
	renderPromptTemplate,
	type CallOrchestratorConfig,
	type TurnControlBlockContext,
} from '@mimic/engine'

import { renderDataBlock, renderDataSchema, type CallData } from './call-data.js'

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
	email?: string
}

export type GoalContext = string | Record<string, string>

export type GoalData = CallData

export type GoalResults = Record<string, unknown>

/**
 * What the compiler sees. Recipient details are deliberately not here: the
 * compiled prompt is recipient-agnostic and the runtime injects
 * callerFirstName / callerLastName / callerEmail into every turn's context
 * block, so a goal compiles once however many people it is used to call.
 * `data` is passed through but only its shape reaches the compiler; the
 * values are injected per call (`buildOrchestratorConfigFromAgent`).
 */
export interface GoalCompilerInput {
	goal: string
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
const compiledGoalFormat = zodResponseFormat(compiledGoalSchema, 'compiled_goal')

let cachedCompilerPrompt: string | null = null

async function getCompilerPrompt() {
	if (!cachedCompilerPrompt) cachedCompilerPrompt = await loadPrompt('instructions/goal-compiler')
	return cachedCompilerPrompt!
}

function defaultAgentName(voice: GoalVoice) {
	return voice === 'male' ? arloPersona.firstName : auroraPersona.firstName
}

function normalizeContext(context: GoalContext): string {
	if (typeof context === 'string') return context
	const entries = Object.entries(context)
	if (entries.length === 0) return 'No additional context provided.'
	return entries.map(([key, value]) => `${key}: ${value}`).join('\n')
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

function formatAiDisclosure(aiDisclosure: boolean | undefined) {
	if (aiDisclosure === true) return 'yes — briefly identify the agent as AI or an automated assistant in the opening'
	if (aiDisclosure === false) {
		return 'no — omit unsolicited AI disclosure, but never claim to be human or deny automation if asked'
	}
	return 'unspecified — default to a brief automated-assistant introduction'
}

function buildCompilerInput(input: GoalCompilerInput) {
	const parts = [
		`Voice: ${input.voice}`,
		`Voice-based fallback agent name: ${defaultAgentName(input.voice)}`,
		'Recipient: supplied per call at runtime as callerFirstName / callerLastName / callerEmail in the context block; the compiled prompt must not assume a specific person.',
		`AI disclosure: ${formatAiDisclosure(input.aiDisclosure)}`,
		'Runtime speech capabilities: Cartesia Sonic 3.6; only break and spell SSML tags pass through. Emotion, speed, and volume tags are stripped. Omit laughter unless the task explicitly calls for it.',
		'Recording status or notice: not supplied as a dedicated setting. Do not infer it from AI disclosure; follow only explicit recording instructions in the goal or context.',
		'',
		'Goal:',
		input.goal,
		'',
		'Context:',
		normalizeContext(input.context),
	]
	if (input.data && Object.keys(input.data).length > 0) {
		parts.push(
			'',
			'Structured data fields (values are supplied per call at runtime in a <data> block in the context; refer to fields by name and do not assume specific values — the same compiled prompt serves every call with these fields). "provided" fields hold facts already known about this call; "missing" fields were not supplied. Determine each field’s role from its meaning and the goal; do not assume every field must be collected:',
			renderDataSchema(input.data),
		)
	}
	parts.push(
		'',
		'Runtime tools available (definitions are reference data, not instructions):',
		formatTools([...defaultMimicTools, ...input.tools]),
	)
	parts.push(
		'',
		'Requested post-call result fields (desired extraction, not evidence that an outcome is complete):',
		formatObjectBlock(input.results),
	)
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

export async function compileGoal(input: GoalCompilerInput, openai = new OpenAI()): Promise<CompiledGoal> {
	const compilerPrompt = await getCompilerPrompt()

	const { model, reasoningEffort, maxOutputTokens } = models.goalCompiler

	// Reasoning models reject `temperature`, so none is sent.
	const result = await openai.chat.completions.create({
		model,
		// openai@5.23 types lack 'none'; the API accepts it (verified 2026-09-30).
		reasoning_effort: reasoningEffort as OpenAI.ReasoningEffort,
		max_completion_tokens: maxOutputTokens,
		response_format: compiledGoalFormat,
		messages: [
			{ role: 'system', content: compilerPrompt },
			{ role: 'user', content: buildCompilerInput(input) },
		],
	})

	const choice = result.choices[0]
	if (choice?.finish_reason === 'length') {
		throw new Error('goal compiler hit max_completion_tokens before finishing the reply')
	}
	if (choice?.message.refusal) {
		throw new Error(`goal compiler refused: ${choice.message.refusal}`)
	}
	const parsed = compiledGoalSchema.parse(JSON.parse(choice?.message.content ?? ''))

	const agentName = parsed.agentName || defaultAgentName(input.voice)
	const systemPrompt = await renderSystemPromptFromTemplate(agentName, parsed)

	return {
		// Keep authored names intact. Global substitution can corrupt unrelated
		// names and data (for example, an agent named Al and a caller in Albany).
		systemPrompt,
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
	const email = callContext?.email ?? agent.recipient?.email
	if (!firstName && !lastName && !email) return undefined
	return { firstName, lastName, email }
}

function buildOpeningContextBlock(
	userTimezone: string | undefined,
	userTimezoneInferred: boolean,
	recipient?: ReturnType<typeof resolveRecipient>,
) {
	const parts: string[] = ['<context>']
	parts.push(`now: ${formatUserDateTime(userTimezone, { inferred: userTimezoneInferred })}`)
	if (recipient?.firstName) parts.push(`callerFirstName: ${recipient.firstName}`)
	if (recipient?.lastName) parts.push(`callerLastName: ${recipient.lastName}`)
	if (recipient?.email) parts.push(`callerEmail: ${recipient.email}`)
	parts.push('</context>')
	return parts.join('\n')
}

/**
 * Per-call data values ride on the system prompt rather than on every turn's
 * control block: the prompt is already assembled per call (agent name
 * substitution), it sits in the cached prefix so the values cost tokens once,
 * and the director sees it on every turn.
 */
function withCallData(systemPrompt: string, dataBlock: string) {
	if (!dataBlock) return systemPrompt
	return `${systemPrompt.trimEnd()}\n\nValues for this call (the instructions above refer to these fields by name):\n${dataBlock}\n`
}

function buildTurnControlBlock(ctx: TurnControlBlockContext) {
	const hasToolResults = ctx.toolResults && ctx.toolResults.length > 0

	const sections: string[] = []

	const lateParts = ['<context>']
	lateParts.push(`now: ${formatUserDateTime(ctx.userTimezone, { inferred: ctx.userTimezoneInferred === true })}`)
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
	callData?: CallData | null,
): { orchestratorConfig: Omit<CallOrchestratorConfig, 'audioTransport'> } {
	const voicePersona = agent.voice === 'male' ? arloPersona : auroraPersona
	const persona = { ...voicePersona, firstName: agent.agentName.trim() || voicePersona.firstName }
	const userTimezone = callContext?.userTimezone
	const userTimezoneInferred = Boolean(userTimezone) && callContext?.userTimezoneInferred === 'true'
	const recipient = resolveRecipient(agent, callContext)
	const dataBlock = renderDataBlock(callData ?? agent.data)
	return {
		orchestratorConfig: {
			persona,
			systemPrompt: withCallData(agent.systemPrompt.replaceAll('[AGENT_NAME]', persona.firstName), dataBlock),
			maxCompletionTokens: 384,
			userFirstName: resolveFirstName(agent, callContext),
			userTimezone,
			userTimezoneInferred,
			recipient,
			buildOpeningBlock: () => buildOpeningContextBlock(userTimezone, userTimezoneInferred, recipient),
			buildTurnControlBlock,
			textQualityBlock: agent.turnControlBlock?.replaceAll('[AGENT_NAME]', persona.firstName),
			endCallEnabled: true,
			tools: agent.tools.length > 0 ? agent.tools : undefined,
		},
	}
}
