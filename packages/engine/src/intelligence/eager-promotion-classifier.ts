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
 * in `prompts/instructions/eager-promotion-classifier.md`. The prompt and its
 * labeled input format were chosen by an offline eval (42 cases × 6 prompts ×
 * 3 models × 3 runs): terse prompts on small models collapsed into
 * always-promote (27 FPs out of 42), while the explicit prompt reached 97.6%
 * accuracy with zero FPs. Re-run that eval before changing the prompt, the
 * input format, or the background model. The opt-in live cases in
 * eager-promotion-classifier.test.ts are a smoke check, not a replacement.
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
 * Non-lexical hesitations only. ASR emits and drops these inconsistently
 * between interim and final transcripts, and none of them can carry intent.
 * Words that are sometimes fillers and sometimes content ("like", "right",
 * "so", "yeah") are deliberately absent: "turn right" is not "turn".
 */
const hesitationTokens = new Set(['uh', 'uhh', 'um', 'umm', 'ah', 'er', 'erm', 'hm', 'hmm', 'mm', 'mhm'])

/**
 * Tokenizes on whitespace and strips separator punctuation that hangs off a
 * token's edges ("uh," → "uh") while keeping punctuation inside a token
 * ("1.5") and a question mark anywhere: "you booked it?" is not "you booked it".
 */
const edgePunctuation = /^[,.;:!"'()\-—–…]+|[,.;:!"'()\-—–…]+$/gu

function stripHesitations(normalized: string): string {
	return normalized
		.split(' ')
		.map((token) => token.replace(edgePunctuation, ''))
		.filter((token) => token.length > 0 && !hesitationTokens.has(token))
		.join(' ')
}

/**
 * Skip the classifier only when the final transcript says the same thing as
 * the one the draft was generated against: identical after normalizing
 * presentation, or identical once pure hesitations are removed. Every
 * substantive difference, including a one-word suffix ("book it" → "book it
 * tomorrow"), goes to the classifier.
 */
export function canFastPathPromote(spec: string, final: string): boolean {
	const normSpec = normalizeForComparison(spec)
	const normFinal = normalizeForComparison(final)
	if (normSpec.length === 0 || normFinal.length === 0) return false
	if (normSpec === normFinal) return true

	const strippedSpec = stripHesitations(normSpec)
	const strippedFinal = stripHesitations(normFinal)
	return strippedSpec.length > 0 && strippedSpec === strippedFinal
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
	const userParts = [
		`Generation-basis transcript (what we prepared against): "${speculativeTranscript}"`,
		`Full transcript (what the caller actually said): "${finalTranscript}"`,
	]
	if (draftResponse) {
		userParts.push(`Agent's prepared response: "${draftResponse}"`)
	}

	const parsed = await callBackgroundModel(
		client,
		systemPrompt,
		userParts.join('\n\n'),
		promotionSchema,
		'eager-promo',
		{
			maxTokens: 50,
			signal,
		},
	)

	return parsed?.promote ?? false
}
