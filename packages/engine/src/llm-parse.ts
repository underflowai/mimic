import type OpenAI from 'openai'
import type { ZodType } from 'zod'

import { config } from '#engine/config.js'
import { createLogger } from '#engine/logger.js'
import { supportsTemperature } from '#engine/models.js'

const log = createLogger('llm-parse')

function extractLlmContent(result: { choices: Array<{ message?: { content?: string | null } }> }) {
	return result.choices[0]?.message?.content?.trim() ?? ''
}

function isAbortLikeError(err: unknown) {
	if (err instanceof DOMException && err.name === 'AbortError') return true
	if (err instanceof Error && err.name === 'AbortError') return true
	return false
}

export function safeParseJsonWithSchema<T extends ZodType>(raw: string, schema: T, tag: string) {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		log.error({ err, tag, snippet: raw.slice(0, 120) }, 'malformed JSON')
		return null
	}
	const result = schema.safeParse(parsed)
	if (!result.success) {
		log.error({ tag, err: result.error }, 'invalid shape')
		return null
	}
	return result.data
}

export interface BackgroundModelOptions {
	temperature?: number
	maxTokens?: number
	signal?: AbortSignal
	model?: string
}

export async function callBackgroundModel<T extends ZodType>(
	client: OpenAI,
	systemPrompt: string,
	userContent: string,
	schema: T,
	tag: string,
	opts?: BackgroundModelOptions,
) {
	if (opts?.signal?.aborted) return null
	try {
		const model = opts?.model ?? config.mimic.backgroundModel
		const reasoningEffort = config.mimic.backgroundReasoningEffort
		const result = await client.chat.completions.create(
			{
				model,
				// openai@5.23 types lack 'none'; the API accepts it (verified 2026-09-30).
				reasoning_effort: reasoningEffort as OpenAI.ReasoningEffort,
				...(supportsTemperature(model, reasoningEffort) && { temperature: opts?.temperature ?? 0 }),
				max_completion_tokens: opts?.maxTokens ?? 100,
				response_format: { type: 'json_object' },
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userContent },
				],
			},
			opts?.signal ? { signal: opts.signal } : undefined,
		)
		if (opts?.signal?.aborted) return null
		const raw = extractLlmContent(result)
		if (!raw) {
			log.error({ tag }, 'empty LLM content')
			return null
		}
		return safeParseJsonWithSchema(raw, schema, tag)
	} catch (err) {
		if (opts?.signal?.aborted || isAbortLikeError(err)) return null
		throw err
	}
}
