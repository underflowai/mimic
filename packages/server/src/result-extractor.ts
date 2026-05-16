/**
 * Post-call result extraction.
 *
 * After a call ends, extracts structured data and goal achievement
 * from the transcript using an LLM.
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

export interface ExtractionResult {
	result: Record<string, unknown>
	goalAchieved: boolean
	goalAchievedReason: string
}

export interface ExtractionInput {
	goal: string
	transcript: TranscriptEntry[]
	/** Schema of what to extract. Keys are field names, values describe what to extract. */
	results: Record<string, unknown>
	toolCalls?: ToolCallRecord[]
	successCondition?: SuccessCondition
}

function formatTranscript(transcript: TranscriptEntry[]) {
	return transcript.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n')
}

function formatResults(results: Record<string, unknown>) {
	const entries = Object.entries(results)
	if (entries.length === 0) return 'None.'
	return entries
		.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
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

/**
 * Extract structured results and goal achievement from a call transcript.
 *
 * Uses an LLM to analyze the transcript against the goal and result schema.
 * Deterministic success conditions (tool_called, field_filled) are evaluated
 * without the LLM when possible.
 *
 * @example
 * ```typescript
 * const extraction = await extractCallResult(openai, {
 *   goal: 'Confirm the appointment',
 *   transcript: [...],
 *   results: { confirmed: 'whether confirmed', notes: 'any notes' },
 * })
 * // extraction.result = { confirmed: true, notes: 'Patient confirmed for 2pm' }
 * // extraction.goalAchieved = true
 * ```
 */
export async function extractCallResult(
	client: OpenAI,
	input: ExtractionInput,
): Promise<ExtractionResult> {
	const deterministic = deterministicSuccess(input.successCondition, {}, input.toolCalls ?? [])

	const systemPrompt = [
		'You are a call result extractor. Given a goal, result schema, and transcript,',
		'extract the requested fields and determine if the goal was achieved.',
		'',
		'Respond with JSON: { "result": { ... }, "goalAchieved": boolean, "goalAchievedReason": "..." }',
		'',
		'The "result" object must have exactly the keys from the result schema.',
		'For boolean fields, use true/false. For missing information, use null.',
	].join('\n')

	const userPrompt = [
		'Goal:', input.goal,
		'',
		'Result schema:', formatResults(input.results),
		'',
		'Tool calls:', formatToolCalls(input.toolCalls ?? []),
		'',
		deterministic
			? `Deterministic goal decision: goalAchieved=${deterministic.value}, reason: ${deterministic.reason}`
			: 'Deterministic goal decision: none (use your judgment)',
		'',
		'Transcript:', formatTranscript(input.transcript),
	].join('\n')

	const response = await client.chat.completions.create({
		model: 'gpt-4o',
		response_format: { type: 'json_object' },
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userPrompt },
		],
	})

	const content = response.choices[0]?.message.content ?? '{}'
	const parsed = JSON.parse(content) as Partial<ExtractionResult>

	const result = parsed.result ?? {}

	const fieldDecision =
		input.successCondition?.type === 'field_filled'
			? deterministicSuccess(input.successCondition, result, input.toolCalls ?? [])
			: deterministic

	return {
		result,
		goalAchieved: fieldDecision?.value ?? parsed.goalAchieved ?? false,
		goalAchievedReason: fieldDecision?.reason ?? parsed.goalAchievedReason ?? '',
	}
}
