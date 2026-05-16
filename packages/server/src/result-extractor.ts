/**
 * Post-call result extraction with typed structured output.
 *
 * Uses OpenAI's structured output (JSON Schema response_format) to
 * enforce exact types on the extraction result — booleans come back
 * as booleans, nullable fields come back as null, not "null".
 */

import OpenAI from 'openai'

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

function isTypedSchema(results: Record<string, unknown>): results is Record<string, TypedField> {
	const first = Object.values(results)[0]
	return first !== null && typeof first === 'object' && 'type' in (first as Record<string, unknown>)
}

function buildJsonSchema(results: Record<string, TypedField>): Record<string, unknown> {
	const properties: Record<string, Record<string, unknown>> = {}
	const required: string[] = []

	for (const [key, field] of Object.entries(results)) {
		const prop: Record<string, unknown> = { description: field.description }

		const baseType = field.type === 'boolean' ? 'boolean' : field.type === 'number' ? 'number' : 'string'

		if (field.nullable) {
			prop.type = [baseType, 'null']
		} else {
			prop.type = baseType
		}

		properties[key] = prop
		if (!field.optional) required.push(key)
	}

	properties.goalAchieved = { type: 'boolean', description: 'Whether the agent achieved its stated goal' }
	properties.goalAchievedReason = { type: 'string', description: 'Brief explanation of why the goal was or was not achieved' }
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
				return `${key} (${f.type}${f.nullable ? ', nullable' : ''}): ${f.description}`
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
				`Success: ${tool.success === false ? 'false' : 'true'}`,
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
		const matched = toolCalls.some((t) => t.name === condition.toolName && t.success !== false)
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

const SYSTEM_PROMPT = [
	'You are a call result extractor. Given a goal, result schema, and transcript,',
	'extract the requested fields and determine if the goal was achieved.',
	'For boolean fields, use true/false. For missing information, use null if nullable.',
].join('\n')

export async function extractCallResult(
	client: OpenAI,
	input: ExtractionInput,
): Promise<ExtractionResult> {
	const deterministic = deterministicSuccess(input.successCondition, {}, input.toolCalls ?? [])

	const userPrompt = [
		'Goal:', input.goal, '',
		'Result schema:', formatResults(input.results), '',
		'Tool calls:', formatToolCalls(input.toolCalls ?? []), '',
		deterministic
			? `Deterministic goal decision: goalAchieved=${deterministic.value}, reason: ${deterministic.reason}`
			: 'Deterministic goal decision: none (use your judgment)',
		'',
		'Transcript:', formatTranscript(input.transcript),
	].join('\n')

	const useStructured = isTypedSchema(input.results)

	const response = await client.chat.completions.create({
		model: 'gpt-4o',
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: userPrompt },
		],
		...(useStructured
			? {
					response_format: {
						type: 'json_schema',
						json_schema: {
							name: 'extraction_result',
							strict: true,
							schema: buildJsonSchema(input.results as Record<string, TypedField>),
						},
					},
				}
			: { response_format: { type: 'json_object' } }),
	})

	const content = response.choices[0]?.message.content ?? '{}'
	const parsed = JSON.parse(content) as Record<string, unknown>

	const goalAchieved = typeof parsed.goalAchieved === 'boolean' ? parsed.goalAchieved : false
	const goalAchievedReason = typeof parsed.goalAchievedReason === 'string' ? parsed.goalAchievedReason : ''

	const result: Record<string, unknown> = {}
	for (const key of Object.keys(input.results)) {
		result[key] = parsed[key] ?? null
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
