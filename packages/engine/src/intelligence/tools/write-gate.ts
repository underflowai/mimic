/**
 * Deterministic post-LLM gate for WRITE tools.
 *
 * The watcher (an LLM) proposes WRITE executions; this gate cross-checks
 * every proposed argument value against ground the call actually
 * produced: prior READ tool results and the caller's own words. A
 * "Tuesday 3 PM" booking must appear in the `checkCalendar` output or in
 * something the caller said before `bookAppointment` may fire.
 *
 * Matching is token-coverage based, not exact substring: the watcher
 * normalizes spoken values ("Tuesday at three" becomes "Tuesday 3:00 PM"),
 * so the gate normalizes number words and requires most value tokens —
 * not all — to appear in a single source. Values with no evidence
 * anywhere block the execution with an instructive error the
 * watcher/director can react to (re-confirm with the caller). Matches are
 * returned as evidence spans — the exact quote that corroborates each
 * argument — which persist in the audit trail.
 */

import type { CallTurn } from '../../shared/prompt-turns.js'
import type { ToolEvidenceSpan } from './types.js'

export interface WriteGateSource {
	/** `read_result:<toolName>` or `caller_turn`. */
	source: string
	text: string
}

export interface WriteGateResult {
	allowed: boolean
	reason: string | null
	evidence: ToolEvidenceSpan[]
	/** Args that had no corroborating evidence. */
	unverified: string[]
}

const minCheckableChars = 3
/** Fraction of a value's tokens that must appear in one source to count as evidence. */
const tokenCoverageThreshold = 0.6

const numberWords: Record<string, string> = {
	zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
	six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11',
	twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
	seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30',
	forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
}

function normalizeTokens(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9@.]+/g, ' ')
		.split(' ')
		.map((token) => numberWords[token] ?? token)
		.filter((token) => {
			if (!token) return false
			// Drop noise tokens that inflate the denominator: bare zeros
			// (from ":00") and single non-digit characters.
			if (/^0+$/.test(token)) return false
			if (token.length === 1 && !/\d/.test(token)) return false
			return true
		})
}

function digitsOf(text: string): string {
	return text.replace(/\D/g, '')
}

/** Digits including spoken number words: "four one five" → "415". */
function spokenDigits(text: string): string {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.map((token) => numberWords[token] ?? token)
		.join('')
		.replace(/\D/g, '')
}

interface SourceIndex {
	source: WriteGateSource
	tokens: Set<string>
	digits: string
}

function indexSources(sources: WriteGateSource[]): SourceIndex[] {
	return sources.map((source) => ({
		source,
		tokens: new Set(normalizeTokens(source.text)),
		digits: spokenDigits(source.text),
	}))
}

function quoteFor(source: WriteGateSource, valueTokens: string[]): string {
	const words = source.text.split(/\s+/).filter(Boolean)
	if (words.length <= 24) return source.text.trim()
	const wanted = new Set(valueTokens)
	const firstMatch = words.findIndex((word) => {
		const normalized = normalizeTokens(word)
		return normalized.some((token) => wanted.has(token))
	})
	const start = Math.max(0, (firstMatch < 0 ? 0 : firstMatch) - 6)
	return words.slice(start, start + 24).join(' ')
}

function findEvidence(value: string, indexed: SourceIndex[]): { source: string; quote: string } | null {
	const valueTokens = normalizeTokens(value)
	const valueDigits = digitsOf(value)
	const digitsCheckable = valueDigits.length >= 4

	if (valueTokens.length === 0 && !digitsCheckable) return null

	for (const entry of indexed) {
		if (valueTokens.length > 0) {
			const matched = valueTokens.filter((token) => entry.tokens.has(token))
			const coverage = matched.length / valueTokens.length
			const hasSubstantiveMatch = matched.some((token) => token.length >= 2)
			if (coverage >= tokenCoverageThreshold && (hasSubstantiveMatch || matched.length === valueTokens.length)) {
				return { source: entry.source.source, quote: quoteFor(entry.source, valueTokens) }
			}
		}
		// Long digit strings (phone numbers, confirmation codes) match on digits alone.
		if (digitsCheckable && entry.digits.includes(valueDigits)) {
			return { source: entry.source.source, quote: quoteFor(entry.source, valueTokens) }
		}
	}
	return null
}

function isCheckable(value: unknown): value is string | number {
	if (typeof value === 'number') return true
	if (typeof value !== 'string') return false
	return value.trim().length >= minCheckableChars
}

export function buildWriteGateSources(
	readResults: Array<{ toolName: string; result: string }>,
	conversationTurns: CallTurn[],
	extraCallerText?: string,
): WriteGateSource[] {
	const sources: WriteGateSource[] = readResults.map((r) => ({
		source: `read_result:${r.toolName}`,
		text: r.result,
	}))
	for (const turn of conversationTurns) {
		if (turn.role !== 'user') continue
		if (!turn.content.trim()) continue
		sources.push({ source: 'caller_turn', text: turn.content })
	}
	if (extraCallerText?.trim()) {
		sources.push({ source: 'caller_turn', text: extraCallerText })
	}
	return sources
}

export function checkWriteArgs(
	toolName: string,
	args: Record<string, unknown>,
	sources: WriteGateSource[],
): WriteGateResult {
	const indexed = indexSources(sources)
	const evidence: ToolEvidenceSpan[] = []
	const unverified: string[] = []

	for (const [arg, rawValue] of Object.entries(args)) {
		if (rawValue === null || rawValue === undefined) continue
		if (typeof rawValue === 'boolean') continue
		if (!isCheckable(rawValue)) continue

		const value = String(rawValue)
		const match = findEvidence(value, indexed)
		if (match) {
			evidence.push({ arg, value, source: match.source, quote: match.quote })
		} else {
			unverified.push(arg)
		}
	}

	if (unverified.length > 0) {
		const detail = unverified.map((arg) => `${arg}=${JSON.stringify(args[arg])}`).join(', ')
		return {
			allowed: false,
			reason:
				`write blocked: ${detail} did not appear in any prior tool result or caller utterance. ` +
				`Confirm the value with the caller (read it back) before calling ${toolName} again.`,
			evidence,
			unverified,
		}
	}

	return { allowed: true, reason: null, evidence, unverified }
}
