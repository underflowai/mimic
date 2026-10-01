import type OpenAI from 'openai'
import { zodResponseFormat } from 'openai/helpers/zod'
import type { ZodType } from 'zod'

import { createLogger } from '#engine/logger.js'
import { models, supportsTemperature } from '#engine/models.js'

import { isAbortLikeError } from './shared/async-utils.js'

const log = createLogger('llm-parse')

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
}

/**
 * One chat completion against the background model with the reply constrained
 * to `schema` (strict structured output). `tag` names the schema on the request
 * and labels logs; it must match `^[a-zA-Z0-9_-]+$`.
 *
 * Strict mode accepts only a subset of JSON Schema keywords; the ones our
 * schemas use (`enum`, nullable via `anyOf`, `minLength`, `maxItems`) were
 * verified live on 2026-09-30. Check before adding others (`default`,
 * `uniqueItems`, `.optional()` are known rejects).
 *
 * Returns null when the call was aborted, the model refused, the reply was cut
 * off at `maxTokens`, or the content could not be decoded.
 */
export async function callBackgroundModel<T extends ZodType>(
	client: OpenAI,
	systemPrompt: string,
	userContent: string,
	schema: T,
	tag: string,
	opts?: BackgroundModelOptions,
) {
	if (opts?.signal?.aborted) return null
	const { model, reasoningEffort } = models.background
	try {
		const result = await client.chat.completions.create(
			{
				model,
				// openai@5.23 types lack 'none'; the API accepts it (verified 2026-09-30).
				reasoning_effort: reasoningEffort as OpenAI.ReasoningEffort,
				...(supportsTemperature(model, reasoningEffort) ? { temperature: opts?.temperature ?? 0 } : {}),
				max_completion_tokens: opts?.maxTokens ?? 100,
				response_format: zodResponseFormat(schema, tag),
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userContent },
				],
			},
			opts?.signal ? { signal: opts.signal } : undefined,
		)
		if (opts?.signal?.aborted) return null
		const choice = result.choices[0]
		if (choice?.finish_reason === 'length') {
			log.error({ tag, maxTokens: opts?.maxTokens ?? 100 }, 'reply cut off at max_completion_tokens')
			return null
		}
		if (choice?.message.refusal) {
			log.warn({ tag, refusal: choice.message.refusal }, 'model refused')
			return null
		}
		const raw = choice?.message.content?.trim() ?? ''
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
