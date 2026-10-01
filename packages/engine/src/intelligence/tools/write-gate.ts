/**
 * Deterministic evidence check for WRITE tool arguments.
 *
 * The watcher (an LLM) proposes a write and its arguments; this gate asks a
 * question the model cannot answer about itself: did each value come from
 * somewhere real? Sources are the caller's own words, prior READ results, and
 * values the integrator supplied for the call (per-call data, context).
 *
 * Two outputs with different weights:
 *
 * - Contact details and identifiers (emails, phone numbers, account or
 *   confirmation codes) with no source anywhere **block** the write. A
 *   hallucinated phone number sends a text to a stranger; these values are
 *   also the ones a caller spells out or a lookup returns, so matching them is
 *   reliable (spoken digits, "john dot smith at gmail dot com").
 * - Everything else (names, dates, free text) is checked with token coverage
 *   and only **recorded**: an evidence span when found, an `unverified` entry
 *   when not. Date and free-text formats vary too much to block on, and the
 *   watcher already requires an authorizing caller quote. The record is what
 *   lets us see, across calls, whether blocking them later would be safe.
 */

import type { CallTurn } from '../../shared/prompt-turns.js'

export type WriteGateSourceKind = 'caller' | 'read_result' | 'known_values'

export interface WriteGateSource {
	kind: WriteGateSourceKind
	/** `caller`, `read_result:<toolName>`, or `known_values`. */
	label: string
	text: string
}

/** The quote that corroborates one argument, kept for the audit trail. */
export interface ToolEvidenceSpan {
	arg: string
	value: string
	source: string
	quote: string
}

export interface WriteGateResult {
	/** Identifier-like arguments with no evidence. Non-empty means the write must wait for a readback. */
	blocked: string[]
	/** Other arguments with no evidence; advisory only. */
	unverified: string[]
	evidence: ToolEvidenceSpan[]
	/** Director-facing note when blocked. */
	reason: string | null
}

export interface BuildSourcesInput {
	readResults?: Array<{ toolName: string; result: string }>
	turns?: CallTurn[]
	/** What the caller just said, when it is not yet part of `turns`. */
	callerTranscript?: string
	/** Integrator-supplied text (per-call data, context) that counts as a legitimate source. */
	knownValues?: string[]
}

export function buildWriteGateSources(input: BuildSourcesInput): WriteGateSource[] {
	const sources: WriteGateSource[] = []
	for (const r of input.readResults ?? []) {
		if (r.result.trim()) sources.push({ kind: 'read_result', label: `read_result:${r.toolName}`, text: r.result })
	}
	for (const turn of input.turns ?? []) {
		if (turn.role === 'user' && turn.content.trim())
			sources.push({ kind: 'caller', label: 'caller', text: turn.content })
	}
	if (input.callerTranscript?.trim()) sources.push({ kind: 'caller', label: 'caller', text: input.callerTranscript })
	for (const text of input.knownValues ?? []) {
		if (text.trim()) sources.push({ kind: 'known_values', label: 'known_values', text })
	}
	return sources
}

const minCheckableChars = 3
/** Fraction of a value's tokens that must appear in one source for token-coverage evidence. */
const tokenCoverageThreshold = 0.6

const numberWords: Record<string, string> = {
	zero: '0',
	oh: '0',
	one: '1',
	two: '2',
	three: '3',
	four: '4',
	five: '5',
	six: '6',
	seven: '7',
	eight: '8',
	nine: '9',
	ten: '10',
	eleven: '11',
	twelve: '12',
	thirteen: '13',
	fourteen: '14',
	fifteen: '15',
	sixteen: '16',
	seventeen: '17',
	eighteen: '18',
	nineteen: '19',
	twenty: '20',
	thirty: '30',
	forty: '40',
	fifty: '50',
	sixty: '60',
	seventy: '70',
	eighty: '80',
	ninety: '90',
}

function spokenToWritten(text: string): string {
	return text
		.toLowerCase()
		.replace(/[’‘]/g, "'")
		.split(/(\s+)/)
		.map((part) => (/\s/.test(part) ? part : (numberWords[part.replace(/[^a-z]/g, '')] ?? part)))
		.join('')
}

function tokensOf(text: string): string[] {
	return spokenToWritten(text)
		.replace(/[^a-z0-9@.]+/g, ' ')
		.split(' ')
		.filter((token) => {
			if (!token) return false
			if (/^0+$/.test(token)) return false // ":00"
			if (token.length === 1 && !/\d/.test(token)) return false
			return true
		})
}

/** "john dot smith at g mail dot com" → "john.smith@gmail.com" */
function compactEmail(text: string): string {
	return spokenToWritten(text)
		.replace(/\s+at\s+/g, '@')
		.replace(/\s+dot\s+/g, '.')
		.replace(/\s+underscore\s+/g, '_')
		.replace(/\s+dash\s+/g, '-')
		.replace(/\s+/g, '')
}

function digitsOf(text: string): string {
	return spokenToWritten(text).replace(/\D/g, '')
}

function compactAlnum(text: string): string {
	return spokenToWritten(text).replace(/[^a-z0-9]/g, '')
}

type StrictKind = 'email' | 'phone' | 'code'

/**
 * Values whose absence from every source blocks the write. Dates, times, and
 * short numbers are deliberately excluded.
 */
export function strictValueKind(value: string): StrictKind | null {
	const trimmed = value.trim()
	if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(trimmed)) return 'email'
	if (
		/^\d{4}-\d{2}-\d{2}/.test(trimmed) ||
		/^\d{1,2}:\d{2}/.test(trimmed) ||
		/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(trimmed)
	) {
		return null
	}
	const digits = trimmed.replace(/\D/g, '')
	if (/^[+\d\s().-]+$/.test(trimmed) && digits.length >= 7) return 'phone'
	if (/^[A-Z0-9-]{6,}$/i.test(trimmed) && digits.length >= 2 && /[A-Z]/i.test(trimmed)) return 'code'
	if (/^\d{6,}$/.test(trimmed)) return 'code'
	return null
}

interface SourceIndex {
	source: WriteGateSource
	tokens: Set<string>
	digits: string
	email: string
	alnum: string
}

function indexSources(sources: WriteGateSource[]): SourceIndex[] {
	return sources.map((source) => ({
		source,
		tokens: new Set(tokensOf(source.text)),
		digits: digitsOf(source.text),
		email: compactEmail(source.text),
		alnum: compactAlnum(source.text),
	}))
}

function quoteFor(source: WriteGateSource, wanted: string[]): string {
	const words = source.text.split(/\s+/).filter(Boolean)
	if (words.length <= 24) return source.text.trim()
	const wantedSet = new Set(wanted)
	const firstMatch = words.findIndex((word) => tokensOf(word).some((token) => wantedSet.has(token)))
	const start = Math.max(0, (firstMatch < 0 ? 0 : firstMatch) - 6)
	return words.slice(start, start + 24).join(' ')
}

function strictMatch(kind: StrictKind, value: string, entry: SourceIndex): boolean {
	switch (kind) {
		case 'email':
			return entry.email.includes(compactEmail(value))
		case 'phone': {
			const digits = digitsOf(value)
			// A stored +1 415 555 1234 is spoken as 415 555 1234: compare national numbers.
			const national = digits.length > 10 ? digits.slice(-10) : digits
			return national.length >= 7 && entry.digits.includes(national)
		}
		case 'code':
			return entry.alnum.includes(compactAlnum(value))
	}
}

function coverageMatch(value: string, entry: SourceIndex): boolean {
	const valueTokens = tokensOf(value)
	if (valueTokens.length === 0) return false
	const matched = valueTokens.filter((token) => entry.tokens.has(token))
	const coverage = matched.length / valueTokens.length
	const substantive = matched.some((token) => token.length >= 2)
	return coverage >= tokenCoverageThreshold && (substantive || matched.length === valueTokens.length)
}

function findEvidence(value: string, indexed: SourceIndex[]): { source: string; quote: string } | null {
	const strict = strictValueKind(value)
	for (const entry of indexed) {
		const matched = strict ? strictMatch(strict, value, entry) : coverageMatch(value, entry)
		if (matched) return { source: entry.source.label, quote: quoteFor(entry.source, tokensOf(value)) }
	}
	// A long digit string inside prose ("my account is 44 71 92 03") still counts.
	const digits = digitsOf(value)
	if (!strict && digits.length >= 4) {
		for (const entry of indexed) {
			if (entry.digits.includes(digits))
				return { source: entry.source.label, quote: quoteFor(entry.source, tokensOf(value)) }
		}
	}
	return null
}

/** Leaf string/number values with dotted paths, so nested params are checked too. */
function checkableLeaves(args: Record<string, unknown>, prefix = ''): Array<{ path: string; value: string }> {
	const leaves: Array<{ path: string; value: string }> = []
	for (const [key, raw] of Object.entries(args)) {
		const path = prefix ? `${prefix}.${key}` : key
		if (raw === null || raw === undefined || typeof raw === 'boolean') continue
		if (typeof raw === 'number' || typeof raw === 'string') {
			const value = String(raw)
			if (value.trim().length >= minCheckableChars) leaves.push({ path, value })
		} else if (Array.isArray(raw)) {
			raw.forEach((item, i) => {
				if (typeof item === 'string' || typeof item === 'number') {
					if (String(item).trim().length >= minCheckableChars)
						leaves.push({ path: `${path}[${i}]`, value: String(item) })
				} else if (item && typeof item === 'object') {
					leaves.push(...checkableLeaves(item as Record<string, unknown>, `${path}[${i}]`))
				}
			})
		} else if (typeof raw === 'object') {
			leaves.push(...checkableLeaves(raw as Record<string, unknown>, path))
		}
	}
	return leaves
}

export function checkWriteArgs(
	toolName: string,
	args: Record<string, unknown>,
	sources: WriteGateSource[],
): WriteGateResult {
	const indexed = indexSources(sources)
	const evidence: ToolEvidenceSpan[] = []
	const unverified: string[] = []
	const blocked: Array<{ path: string; value: string; kind: StrictKind }> = []

	for (const leaf of checkableLeaves(args)) {
		const match = findEvidence(leaf.value, indexed)
		if (match) {
			evidence.push({ arg: leaf.path, value: leaf.value, source: match.source, quote: match.quote })
			continue
		}
		const kind = strictValueKind(leaf.value)
		if (kind) blocked.push({ ...leaf, kind })
		else unverified.push(leaf.path)
	}

	if (blocked.length === 0) return { blocked: [], unverified, evidence, reason: null }

	const described = blocked.map((b) => `${b.path} (${kindLabel(b.kind)} ${JSON.stringify(b.value)})`).join(', ')
	return {
		blocked: blocked.map((b) => b.path),
		unverified,
		evidence,
		reason:
			`${toolName} must wait: ${described} was neither said by the caller nor returned by a lookup. ` +
			'Read the value back to the caller and get an explicit confirmation before it can run.',
	}
}

function kindLabel(kind: StrictKind) {
	return kind === 'email' ? 'email' : kind === 'phone' ? 'phone number' : 'code'
}
