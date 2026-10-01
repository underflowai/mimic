/**
 * Backchannel Classifier
 *
 * Uses a fast background model to decide both whether to play a backchannel
 * and which token to use, based on the caller's transcript.
 *
 * ## Gating
 *
 * Transcripts shorter than `minBackchannelWords` (shared with the engine's
 * gate) short-circuit before the LLM call to save latency / cost.
 *
 * ## Logging
 *
 * Raw caller transcript never enters structured logs (PII). We only log
 * counts, token decisions, and content hashes.
 */

import { createHash } from 'node:crypto'

import type OpenAI from 'openai'
import { z } from 'zod'

import { callBackgroundModel } from '#engine/llm-parse.js'
import { createLogger } from '#engine/logger.js'
import { loadPrompt } from '#engine/prompts.js'

import { minBackchannelWords, neutralBackchannelTokens } from './tokens.js'

const log = createLogger('mimic:bc-classify')

const schema = z.object({
	token: z.enum(neutralBackchannelTokens).nullable(),
})

let cachedPrompt: Promise<string> | null = null
function getSystemPrompt() {
	cachedPrompt ??= loadPrompt('instructions/backchannel-classifier')
	return cachedPrompt
}

function hashSnippet(snippet: string) {
	return createHash('sha256').update(snippet).digest('hex').slice(0, 8)
}

export function createBackchannelClassifier(client: OpenAI, callSignal: AbortSignal) {
	async function classify(transcript: string) {
		const words = transcript.trim().split(/\s+/).filter(Boolean)
		if (words.length < minBackchannelWords) return null

		const snippet = transcript.trim()
		const systemPrompt = await getSystemPrompt()
		const result = await callBackgroundModel(
			client,
			systemPrompt,
			JSON.stringify({ callerTranscript: snippet }),
			schema,
			'backchannel',
			// Variety matters here: at temperature 0 the same transcript shape gets the
			// same token every time. Ignored by models that reject temperature.
			{ temperature: 1, maxTokens: 50, signal: callSignal },
		)

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
