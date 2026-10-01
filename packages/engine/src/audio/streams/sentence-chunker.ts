/**
 * Sentence-boundary chunker transform.
 *
 * Sits between the token readable (LLM deltas) and the TTS synthesis
 * transform, splitting the text stream at sentence boundaries so
 * downstream can fire `text.done` per sentence. The transform passes
 * text through as `delta` events as soon as it is safe to emit, and
 * inserts a `boundary` event once a sentence terminator
 * (`.`, `!`, `?`, optionally followed by closing quotes/brackets and
 * whitespace) is confirmed.
 *
 * Common false positives are not treated as boundaries:
 *   - abbreviations: `Mr.`, `Mrs.`, `Dr.`, `e.g.`, etc.
 *   - decimal numbers: `3.14`
 *   - ellipses followed by more text without whitespace
 *
 * Complete sentences are emitted immediately. This keeps Cartesia input
 * punctuation-safe without holding short openings like "Sure." or "Hi."
 * behind a length threshold.
 */

import { Transform, type TransformCallback } from 'node:stream'

export type SentenceChunkEvent = { type: 'delta'; text: string } | { type: 'boundary' }

export interface SentenceChunkerOptions {
	/**
	 * Emit the first boundary of the stream at a clause break (comma,
	 * semicolon, colon, dash) instead of waiting for a full sentence.
	 * Downstream TTS sends its first batch per boundary, so this converts
	 * "first audio = first sentence" into "first audio = first clause"
	 * (~3 words). Reverts to sentence-sized chunks after the first boundary.
	 */
	firstClauseFlush?: boolean
}

const abbreviations = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'vs', 'etc', 'e.g', 'i.e'])

/** Give up on a clause-level first flush once this much text has buffered
 * without a clause break — past this point the latency win is gone. */
const clauseScanLimitChars = 48

function isTerminator(c: string): boolean {
	return c === '.' || c === '!' || c === '?'
}

function isClosingBracket(c: string): boolean {
	return c === '"' || c === "'" || c === ')' || c === ']' || c === '\u201d' || c === '\u2019'
}

function isWhitespace(c: string): boolean {
	return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'
}

function isDigit(c: string): boolean {
	return c >= '0' && c <= '9'
}

function isLetter(c: string): boolean {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

/**
 * True when the `.` at index `i` is part of an abbreviation or decimal
 * number and should NOT be treated as a sentence terminator.
 */
function isAbbreviationOrDecimal(s: string, i: number): boolean {
	if (s[i] !== '.') return false
	if (i > 0 && isDigit(s[i - 1]) && i + 1 < s.length && isDigit(s[i + 1])) return true
	let start = i
	while (start > 0 && (isLetter(s[start - 1]) || s[start - 1] === '.')) start--
	const word = s.slice(start, i).toLowerCase()
	return abbreviations.has(word)
}

/**
 * Returns the exclusive end index of the first confirmed sentence in
 * `s` starting at `start`. A confirmed sentence ends with a terminator
 * (plus any adjacent terminators and closing brackets) followed by
 * whitespace. Returns -1 when no confirmed boundary exists yet.
 */
function findConfirmedSentenceEnd(s: string, start: number): number {
	for (let i = start; i < s.length; i++) {
		if (!isTerminator(s[i])) continue
		if (isAbbreviationOrDecimal(s, i)) continue
		let j = i + 1
		while (j < s.length && isTerminator(s[j])) j++
		while (j < s.length && isClosingBracket(s[j])) j++
		if (j >= s.length) return -1
		if (isWhitespace(s[j])) return j
		i = j - 1
	}
	return -1
}

/**
 * Returns the length of the prefix of `s` that contains no unresolved
 * terminators — text up to this position is safe to emit as a delta
 * without risking emission past a to-be-decided sentence boundary.
 * Assumes all already-confirmed boundaries have been drained first.
 */
function findSafePrefixEnd(s: string): number {
	for (let i = 0; i < s.length; i++) {
		if (!isTerminator(s[i])) continue
		if (isAbbreviationOrDecimal(s, i)) continue
		let j = i + 1
		while (j < s.length && isTerminator(s[j])) j++
		while (j < s.length && isClosingBracket(s[j])) j++
		if (j >= s.length) return i
		if (isWhitespace(s[j])) return i
		i = j - 1
	}
	return s.length
}

function isClauseBreakChar(c: string): boolean {
	return c === ',' || c === ';' || c === ':' || c === '\u2014' || c === '\u2013'
}

function isWordChar(c: string): boolean {
	return isLetter(c) || isDigit(c)
}

export function createSentenceChunkerTransform(options: SentenceChunkerOptions = {}): Transform {
	let buffer = ''
	let pendingSentenceChars = 0

	// First-clause flush state. Active until the first boundary of any kind
	// is emitted, the scan limit is exceeded, or the clause break fires.
	let clauseMode = options.firstClauseFlush === true
	let clauseWordChars = 0
	let clauseScannedChars = 0
	// A clause char landed at the very end of a delta — confirmed as a break
	// if the next emitted text starts with whitespace.
	let pendingClauseBreak = false

	function exitClauseMode() {
		clauseMode = false
		pendingClauseBreak = false
	}

	/**
	 * Scan `text` for a confirmed clause break, updating scan bookkeeping.
	 * Returns the exclusive end index of the clause (after the break char),
	 * -1 when no confirmed break exists. Sets `pendingClauseBreak` when a
	 * candidate break char ends the text and needs the next chunk to confirm.
	 * Turns clause mode off when the scan limit is exceeded.
	 */
	function findClauseSplit(text: string): number {
		for (let i = 0; i < text.length; i++) {
			if (clauseScannedChars + i > clauseScanLimitChars) {
				exitClauseMode()
				return -1
			}
			const c = text[i]
			if (isClauseBreakChar(c) && clauseWordChars >= 2) {
				if (i === text.length - 1) {
					pendingClauseBreak = true
					return -1
				}
				if (isWhitespace(text[i + 1])) return i + 1
			}
			if (isWordChar(c)) clauseWordChars++
		}
		clauseScannedChars += text.length
		return -1
	}

	/**
	 * Push `text` as delta(s), inserting a clause boundary if this is still
	 * the first emission window of the stream.
	 */
	function pushDelta(self: Transform, text: string) {
		if (!clauseMode) {
			pendingSentenceChars += text.length
			self.push({ type: 'delta', text })
			return
		}

		if (pendingClauseBreak) {
			pendingClauseBreak = false
			if (isWhitespace(text[0])) {
				// The previous delta ended exactly on a clause char — flush it.
				self.push({ type: 'boundary' })
				pendingSentenceChars = 0
				clauseMode = false
				pendingSentenceChars += text.length
				self.push({ type: 'delta', text })
				return
			}
			// Not a real break (e.g. "1," + "000") — keep scanning below.
		}

		const split = findClauseSplit(text)
		if (split === -1) {
			pendingSentenceChars += text.length
			self.push({ type: 'delta', text })
			return
		}

		const head = text.slice(0, split)
		const rest = text.slice(split)
		pendingSentenceChars += head.length
		self.push({ type: 'delta', text: head })
		self.push({ type: 'boundary' })
		pendingSentenceChars = 0
		clauseMode = false
		if (rest.length > 0) {
			pendingSentenceChars += rest.length
			self.push({ type: 'delta', text: rest })
		}
	}

	return new Transform({
		writableObjectMode: true,
		readableObjectMode: true,
		transform(token: unknown, _encoding, callback: TransformCallback) {
			if (typeof token !== 'string' || token.length === 0) {
				callback()
				return
			}
			buffer += token

			while (true) {
				const end = findConfirmedSentenceEnd(buffer, 0)
				if (end === -1) break
				const sentence = buffer.slice(0, end)
				buffer = buffer.slice(end)
				// pushDelta clause-splits the first sentence when clause mode
				// is still active (whole sentence arrived in one token).
				if (sentence.length > 0) pushDelta(this, sentence)
				this.push({ type: 'boundary' })
				pendingSentenceChars = 0
				exitClauseMode()
			}

			const safeEnd = findSafePrefixEnd(buffer)
			if (safeEnd > 0) {
				const safe = buffer.slice(0, safeEnd)
				buffer = buffer.slice(safeEnd)
				pushDelta(this, safe)
			}

			callback()
		},
		flush(callback: TransformCallback) {
			if (buffer.length > 0) {
				pendingSentenceChars += buffer.length
				this.push({ type: 'delta', text: buffer })
				buffer = ''
			}
			if (pendingSentenceChars > 0) {
				this.push({ type: 'boundary' })
				pendingSentenceChars = 0
			}
			callback()
		},
	})
}
