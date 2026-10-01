/**
 * Caller speech classification for turn-taking.
 *
 * While the agent is talking, VAD alone cannot tell "mm-hmm" from "wait,
 * stop". The transcriber can, a few hundred milliseconds later. These pure
 * helpers turn a (possibly partial) caller transcript into a decision the
 * turn actor can act on:
 *
 *   - `none`        no words yet: VAD may be hearing noise or a breath
 *   - `backchannel` listening noises ("mm-hmm", "right", "okay"); the agent
 *                   should keep going and the eventual end-of-turn for these
 *                   words should not become a turn of its own
 *   - `answer`      the same short words, but the agent had just asked a
 *                   question, so they are a reply: keep going, and let the
 *                   end-of-turn be handled as a real turn
 *   - `speech`      anything else: the caller wants the floor
 *
 * Also hosts the hold-request detector used by the silence watchdog.
 */

export type CallerSpeechKind = 'none' | 'backchannel' | 'answer' | 'speech'

export interface CallerSpeechContext {
	/** The agent's current (or just finished) line, used to spot answers to a question. */
	agentDraft?: string
}

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

/** Words that read as a reply when the agent has just asked a question. */
const affirmativeWords = new Set([
	'yeah',
	'yep',
	'yup',
	'yes',
	'ya',
	'sure',
	'okay',
	'ok',
	'kay',
	'alright',
	'right',
	'exactly',
	'totally',
	'true',
	'correct',
	'cool',
	'great',
	'good',
	'nice',
	'perfect',
	'fine',
	'absolutely',
	'definitely',
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

export function endsWithQuestion(text: string): boolean {
	return /\?\s*$/.test(text.trim())
}

export function classifyCallerSpeech(transcript: string, context: CallerSpeechContext = {}): CallerSpeechKind {
	const normalized = normalizeSpeech(transcript)
	if (!normalized) return 'none'

	const words = normalized.split(' ')
	if (words.length > maxBackchannelWords) return 'speech'

	const isPhrase = backchannelPhrases.has(normalized)
	if (!isPhrase) {
		for (const word of words) {
			if (!backchannelWords.has(word)) return 'speech'
		}
		// Fragments like "i" or "got" on their own are more likely the start of
		// a sentence than a listening noise.
		if (words.some((word) => neverAloneWords.has(word))) return 'speech'
	}

	const agentAskedQuestion = context.agentDraft ? endsWithQuestion(context.agentDraft) : false
	if (agentAskedQuestion && words.some((word) => affirmativeWords.has(word))) return 'answer'
	return 'backchannel'
}

export function isBackchannelOnly(transcript: string, context: CallerSpeechContext = {}): boolean {
	return classifyCallerSpeech(transcript, context) === 'backchannel'
}

// ── Hold requests ────────────────────────────────────────────────────

const holdRequest =
	/\b(hold on|hang on|hold please|one (sec|second|moment|minute|min)|a (sec|second|moment|minute|min)|(give|gimme) me (a|one|two|a couple|a few) (sec|seconds?|moments?|minutes?|mins?)|just a (sec|second|moment|minute|min)|bear with me|be right back|brb|let me (just )?(check|grab|find|look|get|pull|open|ask|think)|stay on the line|don'?t hang up|can you (wait|hold)|wait (a|one) (sec|second|moment|minute)|while i (check|grab|find|look|get|pull))\b/i

/** True when the caller asked the agent to wait for them. */
export function isHoldRequest(transcript: string): boolean {
	const text = transcript.trim()
	if (!text) return false
	return holdRequest.test(text)
}
