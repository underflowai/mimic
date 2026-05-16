/**
 * Web Searcher
 *
 * Runs a web search via OpenAI Responses API and returns a concise
 * enrichment string for the control block.
 */

import type OpenAI from 'openai'
import { z } from 'zod'

import { loadPrompt } from '#engine/prompts.js'
import { config } from '#engine/config.js'
import { createLogger } from '#engine/logger.js'

import { safeParseJsonWithSchema } from '#engine/llm-parse.js'
import { formatTurnsForPrompt, type CallTurn } from '../../shared/prompt-turns.js'

const log = createLogger('mimic:web-search')

const searchModel = config.mimic.searchModel
const initialMaxOutputTokens = 1_000
const retryMaxOutputTokens = 2_000

const searchResponseSchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		enrichment: {
			type: ['string', 'null'],
			description:
				'Concise answer for Aurora, max 200 words. Specific numbers, real data, concrete details. Null only if search returned nothing useful.',
		},
	},
	required: ['enrichment'],
} as const

const searchOutputSchema = z.object({
	enrichment: z.string().nullable(),
})

interface SearchResponseLike {
	usage?: { output_tokens?: number | null } | null
	status?: string
	incomplete_details?: { reason?: string | null } | null
}

function parseSearchOutput(text: string) {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return null
	}

	const result = searchOutputSchema.safeParse(parsed)
	return result.success ? result.data : null
}

function responseLooksTruncated(response: SearchResponseLike, maxOutputTokens: number) {
	const outputTokens = response.usage?.output_tokens ?? 0
	const status = response.status
	const reason = response.incomplete_details?.reason
	return status === 'incomplete' || reason === 'max_output_tokens' || outputTokens >= maxOutputTokens
}

export function createWebSearcher(client: OpenAI) {
	let cachedPrompt: string | null = null

	async function getSearchPrompt() {
		if (!cachedPrompt) {
			cachedPrompt = await loadPrompt('instructions/web-searcher')
		}
		return cachedPrompt
	}

	async function search(topic: string, conversationTurns: CallTurn[], callerDateTime?: string, signal?: AbortSignal) {
		const systemPrompt = await getSearchPrompt()
		const conversation = formatTurnsForPrompt(conversationTurns)
		const dateLine = callerDateTime ? `## Current date/time\n${callerDateTime}\n\n` : ''
		const userMessage =
			`${dateLine}## Research topic\n${topic}\n\n` +
			`## Conversation so far\n${conversation}\n\n` +
			`Search for the topic above and provide the answer for Aurora.`

		async function runSearch(maxOutputTokens: number) {
			return client.responses.create(
				{
					model: searchModel,
					max_output_tokens: maxOutputTokens,
					temperature: 0.3,
					instructions: systemPrompt,
					input: userMessage,
					tools: [{ type: 'web_search' }],
					text: {
						format: {
							type: 'json_schema',
							name: 'provide_enrichment',
							schema: searchResponseSchema,
							strict: true,
						},
					},
				},
				signal ? { signal } : undefined,
			)
		}

		let response = await runSearch(initialMaxOutputTokens)

		const searchCount = response.output.filter((item) => item.type === 'web_search_call').length
		const inTok = response.usage?.input_tokens ?? 0
		const outTok = response.usage?.output_tokens ?? 0
		log.info({ searchCount, inputTokens: inTok, outputTokens: outTok }, 'search token usage')

		let text = response.output_text?.trim() ?? ''
		let parsed = parseSearchOutput(text)
		if (!parsed && responseLooksTruncated(response, initialMaxOutputTokens) && !signal?.aborted) {
			log.info({ outputTokens: outTok, maxOutputTokens: initialMaxOutputTokens }, 'retrying truncated search output')
			response = await runSearch(retryMaxOutputTokens)
			text = response.output_text?.trim() ?? ''
			parsed = parseSearchOutput(text)
		}

		if (!parsed) {
			const schemaParsed = safeParseJsonWithSchema(text, searchOutputSchema, 'web-search-output')
			if (!schemaParsed) {
				log.info('invalid or empty structured output')
				return null
			}
			parsed = schemaParsed
		}

		if (signal?.aborted) {
			return null
		}

		const enrichment = parsed?.enrichment ?? null
		log.info({ enrichmentPreview: enrichment?.slice(0, 200) ?? null }, 'search result')
		return enrichment
	}

	return { search }
}

export type WebSearcher = ReturnType<typeof createWebSearcher>
