/**
 * Eager Promotion Classifier
 *
 * Decides whether a pre-generated speculative draft still fits the caller's
 * actual utterance. When the eager pipeline synthesizes a reply against a
 * partial transcript, this classifier checks — once the full transcript
 * arrives — whether the prepared audio should be played (promote) or
 * discarded in favor of a fresh generation.
 *
 * ## Error asymmetry
 *
 * A false positive (reusing a stale spec) means the caller hears a reply
 * that doesn't match what they said. Users feel this immediately.
 * A false negative (discarding a valid spec) costs only latency — we run
 * fresh generation and the user waits ~2–4s. **FP >> FN in cost.**
 *
 * ## Model + prompt
 *
 * Runs on the shared background model (`models.background`) with the prompt
 * in `prompts/instructions/eager-promotion-classifier.md`. The prompt was
 * designed to reject material changes even on the same topic. The opt-in
 * live cases in eager-promotion-classifier.test.ts evaluate the current prompt;
 * historical evaluations of earlier prompts do not validate this version.
 *
 * ### Latency is masked on the critical path
 *
 * Validation runs in parallel with turn-complete dispatch waits. The turn
 * engine only reuses a prepared response after this check passes.
 */

import type OpenAI from 'openai'
import { z } from 'zod'

import { callBackgroundModel } from '#engine/llm-parse.js'
import { loadPrompt } from '#engine/prompts.js'

const promotionSchema = z.object({
	promote: z.boolean(),
})

let cachedPrompt: Promise<string> | null = null
function getSystemPrompt() {
	cachedPrompt ??= loadPrompt('instructions/eager-promotion-classifier')
	return cachedPrompt
}

/** Normalize only presentation differences; preserve Unicode, numbers, and meaning-bearing punctuation. */
function normalizeForComparison(text: string): string {
	return text
		.normalize('NFC')
		.toLowerCase()
		.replace(/[’‘]/g, "'")
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/[.,!]+$/, '')
		.trim()
}

/**
 * Skip the classifier only for nonempty equivalent transcripts. Every new
 * substantive word must be checked against the draft, even a one-word suffix.
 */
export function canFastPathPromote(spec: string, final: string): boolean {
	const normSpec = normalizeForComparison(spec)
	const normFinal = normalizeForComparison(final)
	return normSpec.length > 0 && normSpec === normFinal
}

export async function classifyEagerPromotion(
	client: OpenAI,
	speculativeTranscript: string,
	finalTranscript: string,
	draftResponse: string | null,
	signal?: AbortSignal,
) {
	if (canFastPathPromote(speculativeTranscript, finalTranscript)) {
		return true
	}

	const systemPrompt = await getSystemPrompt()
	const evidence = {
		partialTranscript: speculativeTranscript,
		fullTranscript: finalTranscript,
		draftResponse,
	}

	const parsed = await callBackgroundModel(
		client,
		systemPrompt,
		JSON.stringify(evidence),
		promotionSchema,
		'eager-promo',
		{
			maxTokens: 50,
			signal,
		},
	)

	return parsed?.promote ?? false
}
