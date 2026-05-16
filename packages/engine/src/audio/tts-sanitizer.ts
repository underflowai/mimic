/**
 * TTS text sanitizer
 *
 * Cleans Director LLM output before it reaches the Cartesia Sonic 3.5 TTS WebSocket.
 *   1. Strip markdown via remove-markdown
 *   2. Preserve Cartesia-supported SSML tags: <break>, <spell>
 *   3. Strip unsupported angle-bracket tags (including <emotion>, <speed>, <volume>)
 *   4. Strip leftover malformed tag-like fragments
 *
 * Cartesia SSML docs:
 * https://docs.cartesia.ai/build-with-cartesia/capability-guides/ssml-tags
 */

import removeMd from 'remove-markdown'

// ── Public API ──────────────────────────────────────────────────────

export function sanitizeForTts(text: string) {
	let out = extractTtsControlTags(text).text
	const { cleaned, restore } = protectTtsTags(out)
	out = removeMd(cleaned, { useImgAltText: true })
	out = restore(out)
	out = stripUnsupportedAngleBracketTags(out)
	out = stripInlineJsonObjects(out)
	out = out.replace(/\n{2,}/g, '\n')
	return out
}

export function sanitizeForTranscript(text: string) {
	return stripSquareBracketTags(sanitizeForTts(text))
		.replace(/\s{2,}/g, ' ')
		.trim()
}

export function extractTtsControlTags(text: string) {
	return { text, endCallRequested: false }
}

/**
 * Gate streaming on whether the LLM has finished writing a tag.
 * Dangling `<` or `[` means the LLM is mid-tag — buffer until closed.
 */
export function speechTagTextCanStream(text: string) {
	return !hasDanglingAngleBracket(text) && !hasDanglingSquareBracket(text)
}

// ── Internals ───────────────────────────────────────────────────────

/** SSML tags that Cartesia Sonic 3.5 supports. */
const supportedSsmlTagNames = /^(break|spell)$/i

/**
 * Swap TTS-significant tags for placeholders before markdown stripping so
 * `remove-markdown` doesn't destroy them.
 *
 * Protected: Cartesia SSML tags (<break>, <spell>), and the `[laughter]`
 * non-verbal. Markdown links (`[text](url)`) are NOT protected.
 */
function protectTtsTags(text: string) {
	const tags: string[] = []
	const swap = (match: string) => {
		tags.push(match)
		return `\uFFFDTT${tags.length - 1}\uFFFD`
	}
	let cleaned = text.replace(/<\/?(break|spell)[\s/>][^>]*\/?>/gi, swap)
	cleaned = cleaned.replace(/\[laughter\]/gi, swap)
	const restore = (processed: string) => processed.replace(/\uFFFDTT(\d+)\uFFFD/g, (_, idx) => tags[Number(idx)])
	return { cleaned, restore }
}

/**
 * Strip angle-bracket tags except the SSML tags Cartesia supports.
 */
function stripUnsupportedAngleBracketTags(text: string) {
	return text.replace(/<\/?([a-z][a-z0-9-]*)(?:\s[^>]*)?\/?>/gi, (match, tagName: string) => {
		if (supportedSsmlTagNames.test(tagName)) return match
		return ''
	})
}

function stripSquareBracketTags(text: string) {
	return text.replace(/\s*\[[^\]]+\]\s*/g, ' ').trim()
}

function stripInlineJsonObjects(text: string) {
	return text.replace(/\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s*/g, (match) => {
		const trimmed = match.trim()
		try {
			const parsed = JSON.parse(trimmed)
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return ' '
		} catch {
			// not valid JSON, keep it
		}
		return match
	})
}

function hasDanglingAngleBracket(text: string) {
	const lastOpen = text.lastIndexOf('<')
	if (lastOpen > text.lastIndexOf('>')) {
		const fragment = text.slice(lastOpen + 1)
		if (/^\s*\/?[a-z]/i.test(fragment)) return true
	}
	return false
}

function hasDanglingSquareBracket(text: string) {
	const lastOpen = text.lastIndexOf('[')
	if (lastOpen > text.lastIndexOf(']')) {
		const fragment = text.slice(lastOpen + 1)
		if (/^\s*[a-z]/i.test(fragment)) return true
	}
	return false
}
