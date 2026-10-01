/**
 * Post-call result extraction with typed structured output.
 *
 * Uses OpenAI's structured output (JSON Schema response_format) to
 * enforce exact types on the extraction result — booleans come back
 * as booleans, nullable fields come back as null, not "null".
 */

import OpenAI from 'openai'

import { loadPrompt, models } from '@mimic/engine'

export interface TranscriptEntry {
	role: 'user' | 'assistant'
	content: string
}

export type SuccessCondition =
	| { type: 'llm_evaluated' }
	| { type: 'tool_called'; toolName: string }
	| { type: 'field_filled'; fieldName: string }

export interface ToolCallRecord {
	name: string
	input: unknown
	output: unknown
	success?: boolean
}

export interface TypedField {
	type: string
	description: string
	nullable?: boolean
	optional?: boolean
}

export interface ExtractionResult {
	result: Record<string, unknown>
	goalAchieved: boolean
	goalAchievedReason: string
}

export interface ExtractionInput {
	goal: string
	transcript: TranscriptEntry[]
	/** Typed schema for extraction. Each field has type + description + nullable/optional. */
	results: Record<string, unknown> | Record<string, TypedField>
	toolCalls?: ToolCallRecord[]
	successCondition?: SuccessCondition
}

function normalizeToTypedSchema(results: Record<string, unknown>): Record<string, TypedField> {
	const typed: Record<string, TypedField> = {}
	for (const [key, value] of Object.entries(results)) {
		if (value !== null && typeof value === 'object' && 'type' in (value as Record<string, unknown>)) {
			typed[key] = value as TypedField
		} else {
			typed[key] = {
				type: 'string',
				description: typeof value === 'string' ? value : String(value ?? key),
				nullable: true,
			}
		}
	}
	return typed
}

function buildJsonSchema(results: Record<string, TypedField>): Record<string, unknown> {
	const properties: Record<string, Record<string, unknown>> = {}
	const required: string[] = []

	for (const [key, field] of Object.entries(results)) {
		const prop: Record<string, unknown> = { description: field.description }

		const baseType = field.type === 'boolean' ? 'boolean' : field.type === 'number' ? 'number' : 'string'

		// Missing evidence must remain unknown even for a business-required field.
		// Strict structured output requires every property in `required`; optional
		// caller input is represented by null instead of an omitted JSON key.
		prop.type = [baseType, 'null']

		properties[key] = prop
		required.push(key)
	}

	properties.goalAchieved = { type: 'boolean', description: 'Whether the agent achieved its stated goal' }
	properties.goalAchievedReason = {
		type: 'string',
		description: 'Brief explanation of why the goal was or was not achieved',
	}
	required.push('goalAchieved', 'goalAchievedReason')

	return {
		type: 'object',
		properties,
		required,
		additionalProperties: false,
	}
}

function formatTranscript(transcript: TranscriptEntry[]) {
	return transcript.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n')
}

function formatResults(results: Record<string, unknown>) {
	return Object.entries(results)
		.map(([key, value]) => {
			if (typeof value === 'object' && value !== null && 'description' in value) {
				const f = value as TypedField
				return `${key} (${f.type}; unknown = null${f.optional ? '; optional' : ''}): ${f.description}`
			}
			return `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
		})
		.join('\n')
}

function formatToolCalls(toolCalls: ToolCallRecord[]) {
	if (toolCalls.length === 0) return 'None.'
	return toolCalls
		.map((tool) =>
			[
				`Tool: ${tool.name}`,
				`Execution success: ${tool.success === undefined ? 'unknown' : String(tool.success)}`,
				`Input: ${JSON.stringify(tool.input)}`,
				`Output: ${JSON.stringify(tool.output)}`,
			].join('\n'),
		)
		.join('\n\n')
}

function deterministicSuccess(
	condition: SuccessCondition | undefined,
	result: Record<string, unknown>,
	toolCalls: ToolCallRecord[],
) {
	if (!condition || condition.type === 'llm_evaluated') return null
	if (condition.type === 'tool_called') {
		const matched = toolCalls.some((t) => t.name === condition.toolName && t.success === true)
		return {
			value: matched,
			reason: matched
				? `Tool ${condition.toolName} was called successfully.`
				: `Tool ${condition.toolName} was not called successfully.`,
		}
	}
	const value = result[condition.fieldName]
	const filled = value !== null && value !== undefined && String(value).trim().length > 0
	return {
		value: filled,
		reason: filled ? `Field ${condition.fieldName} was filled.` : `Field ${condition.fieldName} was not filled.`,
	}
}

let cachedSystemPrompt: Promise<string> | null = null
function getSystemPrompt() {
	cachedSystemPrompt ??= loadPrompt('instructions/result-extractor')
	return cachedSystemPrompt
}

export async function extractCallResult(client: OpenAI, input: ExtractionInput): Promise<ExtractionResult> {
	const deterministic =
		input.successCondition?.type === 'tool_called'
			? deterministicSuccess(input.successCondition, {}, input.toolCalls ?? [])
			: null

	const typedResults = normalizeToTypedSchema(input.results)
	const userPrompt = [
		'Goal:',
		input.goal,
		'',
		'Result schema:',
		formatResults(typedResults),
		'',
		'Tool calls:',
		formatToolCalls(input.toolCalls ?? []),
		'',
		deterministic
			? `Deterministic goal decision: goalAchieved=${deterministic.value}, reason: ${deterministic.reason}`
			: 'Deterministic goal decision: none (use your judgment)',
		'',
		'Transcript:',
		formatTranscript(input.transcript),
	].join('\n')

	const { model, reasoningEffort } = models.resultExtractor
	const response = await client.chat.completions.create({
		model,
		// openai@5.23 types lack 'none'; the API accepts it (verified 2026-09-30).
		reasoning_effort: reasoningEffort as OpenAI.ReasoningEffort,
		messages: [
			{ role: 'system', content: await getSystemPrompt() },
			{ role: 'user', content: userPrompt },
		],
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'extraction_result',
				strict: true,
				schema: buildJsonSchema(typedResults),
			},
		},
	})

	const choice = response.choices[0]
	let parsed: Record<string, unknown> = {}
	let extractionAvailable = false
	if (choice && choice.finish_reason === 'stop' && !choice.message.refusal && choice.message.content) {
		try {
			const value: unknown = JSON.parse(choice.message.content)
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				const candidate = value as Record<string, unknown>
				const validFields = Object.entries(typedResults).every(([key, field]) => {
					const expectedType = field.type === 'boolean' ? 'boolean' : field.type === 'number' ? 'number' : 'string'
					return Object.hasOwn(candidate, key) && (candidate[key] === null || typeof candidate[key] === expectedType)
				})
				if (
					validFields &&
					typeof candidate.goalAchieved === 'boolean' &&
					typeof candidate.goalAchievedReason === 'string'
				) {
					parsed = candidate
					extractionAvailable = true
				}
			}
		} catch {
			// An incomplete/refused/invalid extraction cannot establish caller facts.
		}
	}

	const goalAchieved = typeof parsed.goalAchieved === 'boolean' ? parsed.goalAchieved : false
	const goalAchievedReason =
		extractionAvailable && typeof parsed.goalAchievedReason === 'string'
			? parsed.goalAchievedReason
			: 'Goal completion could not be verified because result extraction was unavailable.'

	const result: Record<string, unknown> = {}
	for (const [key, field] of Object.entries(typedResults)) {
		const expectedType = field.type === 'boolean' ? 'boolean' : field.type === 'number' ? 'number' : 'string'
		result[key] = typeof parsed[key] === expectedType ? parsed[key] : null
	}

	const fieldDecision =
		input.successCondition?.type === 'field_filled'
			? deterministicSuccess(input.successCondition, result, input.toolCalls ?? [])
			: deterministic

	return {
		result,
		goalAchieved: fieldDecision?.value ?? goalAchieved,
		goalAchievedReason: fieldDecision?.reason ?? goalAchievedReason,
	}
}
