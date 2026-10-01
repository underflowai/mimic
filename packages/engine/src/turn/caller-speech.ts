/**
 * Caller speech classification for turn-taking.
 *
 * While the agent is talking, VAD alone cannot tell "mm-hmm" from "wait,
 * stop". The transcriber can, a few hundred milliseconds later. This is the
 * one lexical decision in the engine, and it only ever decides whether the
 * agent may *keep talking* for now:
 *
 *   - `none`        no words yet: VAD may be hearing noise or a breath
 *   - `backchannel` listening noises or short acknowledgements ("mm-hmm",
 *                   "right", "okay"); the agent keeps going
 *   - `speech`      anything else, including any utterance ending in a
 *                   question mark: the caller wants the floor
 *
 * The decision is provisional. The turn actor re-runs it on every interim
 * transcript after resuming, so "yeah… but actually" yields as soon as the
 * words past "yeah" arrive, and the call machine never drops a caller's
 * end-of-turn on these words once the agent has stopped talking (the
 * director sees it with an overlap hint instead). Anything not recognised
 * is `speech`: the list can only ever make the agent yield later, never
 * silence the caller.
 */

export type CallerSpeechKind = 'none' | 'backchannel' | 'speech'

const backchannelWords = new Set([
	'mm',
	'mhm',
	'mmhmm',
	'hmm',
	'hm',
	'uh',
	'um',
	'huh',
	'uhhuh',
	'ah',
	'oh',
	'yeah',
	'yep',
	'yup',
	'yes',
	'ya',
	'right',
	'okay',
	'ok',
	'kay',
	'sure',
	'alright',
	'true',
	'exactly',
	'totally',
	'cool',
	'nice',
	'great',
	'good',
	'gotcha',
	'i',
	'see',
	'got',
	'it',
	'makes',
	'sense',
	'wow',
	'really',
	'interesting',
	'perfect',
	'fine',
	'correct',
	'absolutely',
	'definitely',
])

/** Short backchannels built from several words; checked as a whole so "i" and "see" alone don't qualify. */
const backchannelPhrases = new Set([
	'i see',
	'oh i see',
	'got it',
	'oh got it',
	'okay got it',
	'makes sense',
	'oh okay',
	'oh right',
	'ah okay',
	'oh yeah',
	'yeah yeah',
	'okay okay',
	'right right',
	'oh really',
	'oh wow',
	'oh nice',
	'oh interesting',
])

/** Standalone filler words that never form a backchannel by themselves. */
const neverAloneWords = new Set(['i', 'see', 'got', 'it', 'makes', 'sense'])

const maxBackchannelWords = 4

export function normalizeSpeech(transcript: string): string {
	return transcript
		.toLowerCase()
		.replace(/[-']/g, '')
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/** "Right?" / "Okay?" / "Hello?": the caller is asking, not listening. */
function asksForTheFloor(transcript: string): boolean {
	return /\?\s*$/.test(transcript.trim())
}

export function classifyCallerSpeech(transcript: string): CallerSpeechKind {
	const normalized = normalizeSpeech(transcript)
	if (!normalized) return 'none'
	if (asksForTheFloor(transcript)) return 'speech'

	const words = normalized.split(' ')
	if (words.length > maxBackchannelWords) return 'speech'
	if (backchannelPhrases.has(normalized)) return 'backchannel'

	for (const word of words) {
		if (!backchannelWords.has(word)) return 'speech'
	}
	// Fragments like "i" or "got" on their own are more likely the start of
	// a sentence than a listening noise.
	if (words.some((word) => neverAloneWords.has(word))) return 'speech'
	return 'backchannel'
}
