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
 * Selected via `scripts/mimic/eval-eager-promotion.manual.ts` across
 * 42 cases × 6 prompts × 3 models × 3 runs (2268 classifications):
 *
 *   | Model / Prompt                    | Acc   | FP | FN | Latency |
 *   |-----------------------------------|-------|----|----|---------|
 *   | 8B + terse (previous production)  | 78.6% | 27 |  0 | 310ms   |
 *   | 70B + v2-explicit (this file)     | 97.6% |  0 |  3 | 591ms   |
 *
 * The 8B model could not discriminate on this task at any prompt — it
 * collapsed into always-promote (previous prod, 27 FPs out of 42) or
 * always-discard. The 70B actually reasons about the transcript delta
 * and draft fit.
 *
 * ### Latency is masked on the critical path
 *
 * Validation runs in parallel with turn-complete dispatch waits. The turn
 * engine only reuses a prepared response after this check passes.
 */

import type OpenAI from 'openai'
import { z } from 'zod'

import { loadPrompt } from '#engine/prompts.js'
import { callBackgroundModel } from '#engine/llm-parse.js'

const promotionSchema = z.object({
	promote: z.boolean(),
})

let cachedPrompt: string | null = null
async function getSystemPrompt() {
	if (!cachedPrompt) cachedPrompt = await loadPrompt('instructions/eager-promotion-classifier')
	return cachedPrompt
}

/**
 * Normalizes a transcript for comparison: trims, lowercases, strips
 * trailing punctuation and all non-alphanumeric characters except spaces.
 */
function normalizeForComparison(t: string): string {
	return t
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

const multiWordFillers = ['i mean', 'you know']
const singleWordFillers = new Set([
	'uh',
	'um',
	'ah',
	'er',
	'like',
	'so',
	'well',
	'yeah',
	'yep',
	'right',
	'okay',
	'ok',
	'actually',
	'basically',
	'honestly',
	'anyway',
	'anyways',
])

/**
 * Strips ASR filler words and disfluencies that cannot change caller intent.
 * Multi-word fillers are removed first, then single-word fillers.
 */
function stripFiller(text: string): string {
	let out = text
	for (const phrase of multiWordFillers) out = out.replaceAll(phrase, ' ')
	return out
		.split(/\s+/)
		.filter((w) => w.length > 0 && !singleWordFillers.has(w))
		.join(' ')
}

/**
 * Tiered fast-path: determines whether the speculative transcript is
 * close enough to the final transcript to skip the 70B LLM classifier.
 *
 *   Tier 1: Normalized exact match (punctuation/case differences).
 *   Tier 2: Equal after stripping ASR filler words.
 *   Tier 3: Spec is a prefix of final (after filler strip) with <= 2
 *           trailing substantive words.
 */
export function canFastPathPromote(spec: string, final: string): boolean {
	const normSpec = normalizeForComparison(spec)
	const normFinal = normalizeForComparison(final)

	if (normSpec === normFinal) return true

	const strippedSpec = stripFiller(normSpec)
	const strippedFinal = stripFiller(normFinal)

	if (strippedSpec === strippedFinal) return true

	if (strippedFinal.startsWith(strippedSpec)) {
		const tail = strippedFinal.slice(strippedSpec.length).trim()
		const tailWords = tail.split(/\s+/).filter(Boolean)
		if (tailWords.length <= 2) return true
	}

	return false
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
