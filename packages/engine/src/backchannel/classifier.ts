/**
 * Backchannel Classifier
 *
 * Uses a fast background model to decide both whether to play a backchannel
 * and which token to use, based on the caller's transcript.
 *
 * ## Gating
 *
 * Minimum word count is `minClassifyWords`, aligned with
 * `engine`'s default `minWordCount`. Shorter transcripts
 * short-circuit before the LLM call to save latency / cost.
 *
 * ## Logging
 *
 * Raw caller transcript never enters structured logs (PII). We only log
 * counts, token decisions, and content hashes.
 */

import { createHash } from 'node:crypto'

import type OpenAI from 'openai'
import { z } from 'zod'

import { loadPrompt } from '#engine/prompts.js'
import { callBackgroundModel } from '#engine/llm-parse.js'
import { createLogger } from '#engine/logger.js'

const log = createLogger('mimic:bc-classify')

const backchannelTokens = ['mm-hmm', 'uh-huh', 'yeah', 'right', 'sure', 'got-it', 'i-see', 'okay'] as const

const schema = z.object({
	token: z.enum(backchannelTokens).nullable(),
})

/**
 * Must stay in sync with `engine`'s default `minWordCount`.
 * Pulled into a shared constant so drift is a compile-time error if either
 * side changes the minimum.
 */
const minClassifyWords = 4

let cachedPrompt: string | null = null
async function getSystemPrompt() {
	if (!cachedPrompt) cachedPrompt = await loadPrompt('instructions/backchannel-classifier')
	return cachedPrompt
}

function hashSnippet(snippet: string) {
	return createHash('sha256').update(snippet).digest('hex').slice(0, 8)
}

export function createBackchannelClassifier(client: OpenAI, callSignal: AbortSignal) {
	async function classify(transcript: string) {
		const words = transcript.trim().split(/\s+/).filter(Boolean)
		if (words.length < minClassifyWords) return null

		const snippet = words.slice(-50).join(' ')
		const systemPrompt = await getSystemPrompt()
		const result = await callBackgroundModel(client, systemPrompt, snippet, schema, 'backchannel', {
			temperature: 1,
			maxTokens: 50,
			signal: callSignal,
		})

		const token = result?.token ?? null
		const snippetHash = hashSnippet(snippet)
		if (!token) {
			log.info({ snippetHash, wordCount: words.length }, 'backchannel skipped')
			return null
		}

		log.info({ token, snippetHash, wordCount: words.length }, 'backchannel classification')
		return token
	}

	return { classify }
}

export type BackchannelClassifier = ReturnType<typeof createBackchannelClassifier>
