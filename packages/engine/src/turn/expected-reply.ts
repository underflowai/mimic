/**
 * Expected-reply classification — question-aware turn boundaries.
 *
 * After the agent asks a closed question ("Does 2pm work?") the caller's
 * reply is almost always 1–5 words, so the engine can commit their turn
 * aggressively. After an open prompt ("How did that happen?") callers
 * routinely pause mid-thought, so the engine should stretch its patience.
 *
 * Pure regex over the agent's final sentence — no LLM on this path. The
 * result feeds the early-commit guard interval and the silence-watchdog
 * delay; both fail soft, so misclassification costs a few hundred
 * milliseconds of patience in the wrong direction, never correctness.
 */

export type ExpectedReply = 'short' | 'long' | 'neutral'

const closedAuxiliaries = new Set([
	'do',
	'does',
	'did',
	'is',
	'are',
	'was',
	'were',
	'am',
	'can',
	'could',
	'would',
	'will',
	'should',
	'shall',
	'may',
	'might',
	'has',
	'have',
	'had',
])

const openLeads = new Set(['what', 'how', 'why', 'where', 'when', 'who', 'whom', 'whose', 'which'])

const shortTagEndings = /\b(?:right|okay|ok|correct|yeah|alright|good|fair)\s*\?$/

/** Returns the final question of the response, or null when it does not end with one. */
function extractFinalQuestion(agentResponse: string): string | null {
	const trimmed = agentResponse.trim().replace(/["'\u201d\u2019)\]]+$/, '')
	if (!trimmed.endsWith('?')) return null
	// Slice from the previous sentence terminator so only the final
	// question is classified, not the whole turn.
	const withoutFinal = trimmed.slice(0, -1)
	let start = -1
	for (let i = withoutFinal.length - 1; i >= 0; i--) {
		const c = withoutFinal[i]
		if (c === '.' || c === '!' || c === '?') {
			start = i
			break
		}
	}
	return trimmed.slice(start + 1).trim()
}

export function classifyExpectedReply(agentResponse: string): ExpectedReply {
	const question = extractFinalQuestion(agentResponse)
	if (!question) return 'neutral'

	const normalized = question.toLowerCase()

	// Tag questions ("…, right?") and A-or-B choices resolve in a word or two.
	if (shortTagEndings.test(normalized)) return 'short'
	if (/\bor\b/.test(normalized)) return 'short'

	const firstWord = normalized.match(/[a-z']+/)?.[0]
	if (!firstWord) return 'neutral'
	if (closedAuxiliaries.has(firstWord)) return 'short'
	if (openLeads.has(firstWord)) return 'long'

	return 'neutral'
}
