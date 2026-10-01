/**
 * Speech pacing heuristics and interrupt shaping.
 *
 * Sample-format constants live in `audio-format.ts`; this module is about
 * how speech relates to time.
 */

import { ttsBytesPerSample, ttsSampleRate } from './audio-format.js'

/** One synthesized word as timed by the TTS provider, relative to the start of the turn's audio. */
export interface WordTiming {
	word: string
	startMs: number
	endMs: number
}

/** ~150 wpm. Fallback for heard-portion estimation when no word timeline is available. */
export const avgMsPerWord = 400

/** Audio tail kept after an interrupt — matches Levelt's measured stop latency (150–200 ms). */
export const interruptDrainMs = 200

/** Linear fade applied to the interrupt drain tail. */
export const interruptFadeMs = 50

/**
 * Fade applied wherever a PCM stream is cut mid-sample: the end of a flushed
 * remainder frame and the end of a synthesis pass. Short enough to be inaudible.
 */
export const ttsTailFadeMs = 10

/** Words of `draft` whose playback had finished by `playedMs`, per the provider's word timeline. */
function countWordsHeard(timeline: readonly WordTiming[], playedMs: number) {
	let count = 0
	for (const word of timeline) {
		if (word.endMs > playedMs) break
		count++
	}
	return count
}

/**
 * The part of `draft` the caller actually heard before an interrupt.
 *
 * `playedMs` is how much of the turn's audio reached the caller. With the TTS
 * provider's word timeline this is exact to the word; without one it falls back
 * to the average-speech-rate estimate. The result is snapped back to the last
 * clause boundary so the transcript never ends mid-thought.
 */
export function estimateHeardPortion(draft: string, playedMs: number, timeline: readonly WordTiming[] = []) {
	if (!draft || playedMs <= 0) return ''
	const words = draft.split(/\s+/).filter(Boolean)
	const wordsHeard = Math.min(
		words.length,
		timeline.length > 0 ? countWordsHeard(timeline, playedMs) : Math.floor(playedMs / avgMsPerWord),
	)
	const rawPortion = words.slice(0, wordsHeard).join(' ')
	const boundaryMatch = rawPortion.match(/^(.*[.!?,;—])\s*/s)
	return boundaryMatch ? boundaryMatch[1] : rawPortion
}

/** Returns a copy of `buf` whose final `fadeMs` fade linearly to silence. Buffers shorter than the fade are returned as-is. */
export function applyLinearFade(buf: Buffer, fadeMs: number) {
	const fadeSamples = Math.round((ttsSampleRate * fadeMs) / 1000)
	const fadeBytes = fadeSamples * ttsBytesPerSample
	if (buf.length < fadeBytes) return buf
	const out = Buffer.from(buf)
	const startOffset = out.length - fadeBytes
	for (let i = 0; i < fadeSamples; i++) {
		const pos = startOffset + i * ttsBytesPerSample
		if (pos + 1 >= out.length) break
		const sample = out.readInt16LE(pos)
		out.writeInt16LE(Math.round(sample * (1 - (i + 1) / fadeSamples)), pos)
	}
	return out
}
