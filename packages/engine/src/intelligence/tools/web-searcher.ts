/**
 * Web Searcher
 *
 * Runs a web search via OpenAI Responses API and returns a concise
 * enrichment string for the control block.
 */

import type OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import { z } from 'zod'

import { safeParseJsonWithSchema } from '#engine/llm-parse.js'
import { createLogger } from '#engine/logger.js'
import { models, supportsTemperature } from '#engine/models.js'
import { renderPromptTemplate } from '#engine/prompts.js'

import { formatTurnsForPrompt, type CallTurn } from '../../shared/prompt-turns.js'

const log = createLogger('mimic:web-search')

const initialMaxOutputTokens = 1_000
const retryMaxOutputTokens = 2_000

const searchOutputSchema = z.object({
	enrichment: z
		.string()
		.nullable()
		.describe(
			'Concise answer for the voice agent, max 150 words. Direct answer grounded in web results, with short source attribution and relevant dates. State material uncertainty. Null only if search returned nothing useful.',
		),
})
const searchOutputFormat = zodTextFormat(searchOutputSchema, 'provide_enrichment')

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

export interface WebSearcherOptions {
	/** The voice agent's name, so the researcher knows who it is briefing. */
	agentName: string
}

export function createWebSearcher(client: OpenAI, options: WebSearcherOptions) {
	const { agentName } = options
	const { model } = models.webSearch
	let cachedPrompt: Promise<string> | null = null

	function getSearchPrompt() {
		cachedPrompt ??= renderPromptTemplate('instructions/web-searcher', { agentName })
		return cachedPrompt
	}

	async function search(topic: string, conversationTurns: CallTurn[], callerDateTime?: string, signal?: AbortSignal) {
		if (signal?.aborted) return null
		const systemPrompt = await getSearchPrompt()
		const conversation = formatTurnsForPrompt(conversationTurns, { agentLabel: agentName })
		const now = callerDateTime || `${new Date().toISOString()} (UTC fallback; caller timezone unknown)`
		const dateLine = `## Current date/time\n${now}\n\n`
		const userMessage = `${dateLine}## Research topic\n${topic}\n\n## Conversation so far\n${conversation}`

		async function runSearch(maxOutputTokens: number) {
			return client.responses.create(
				{
					model,
					max_output_tokens: maxOutputTokens,
					...(supportsTemperature(model) ? { temperature: 0.3 } : {}),
					instructions: systemPrompt,
					input: userMessage,
					tools: [{ type: 'web_search' }],
					tool_choice: 'required',
					text: { format: searchOutputFormat },
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
		if (responseLooksTruncated(response, initialMaxOutputTokens) && !signal?.aborted) {
			log.info({ outputTokens: outTok, maxOutputTokens: initialMaxOutputTokens }, 'retrying truncated search output')
			response = await runSearch(retryMaxOutputTokens)
			text = response.output_text?.trim() ?? ''
			parsed = parseSearchOutput(text)
		}

		// The final response must contain completed research. A plausible answer (or a
		// search from an earlier, discarded retry) is not evidence for this handoff.
		const completedSearch = response.output.some(
			(item) => item.type === 'web_search_call' && item.status === 'completed',
		)
		if (
			!completedSearch ||
			(response.status && response.status !== 'completed') ||
			responseLooksTruncated(response, retryMaxOutputTokens)
		) {
			log.warn({ completedSearch, status: response.status }, 'discarding unverified or incomplete research')
			return null
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

		const enrichment = parsed?.enrichment?.trim() || null
		if (enrichment && enrichment.split(/\s+/u).length > 150) {
			log.warn('discarding enrichment that exceeds the 150-word handoff limit')
			return null
		}
		log.info({ enrichmentPreview: enrichment?.slice(0, 200) ?? null }, 'search result')
		return enrichment
	}

	return { search }
}

export type WebSearcher = ReturnType<typeof createWebSearcher>
