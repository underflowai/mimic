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

const abbreviations = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'vs', 'etc', 'e.g', 'i.e'])

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

export function createSentenceChunkerTransform(): Transform {
	let buffer = ''
	let pendingSentenceChars = 0

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
				if (sentence.length > 0) {
					pendingSentenceChars += sentence.length
					this.push({ type: 'delta', text: sentence })
				}
				this.push({ type: 'boundary' })
				pendingSentenceChars = 0
			}

			const safeEnd = findSafePrefixEnd(buffer)
			if (safeEnd > 0) {
				const safe = buffer.slice(0, safeEnd)
				buffer = buffer.slice(safeEnd)
				pendingSentenceChars += safe.length
				this.push({ type: 'delta', text: safe })
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
