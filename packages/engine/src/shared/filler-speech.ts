/**
 * Filler / assent speech detection.
 *
 * Used by the soft-pause escalation path: when the substantive-speech
 * timer fires while the agent is paused, a partial transcript that is
 * pure filler or assent ("yeah", "mm-hmm, okay", "right right") means
 * the caller is backchanneling, not taking the turn — the agent should
 * keep the pause and resume rather than treat it as an interrupt.
 *
 * The word list extends the ASR filler strip list used by the eager
 * promotion classifier (`intelligence/eager-promotion-classifier.ts`)
 * with assent/acknowledgment tokens. The lists are intentionally kept
 * separate: adding assent words like "yes" to the promotion strip list
 * would change transcript-equality semantics there.
 */

const multiWordFillers = ['i mean', 'you know', 'got it', 'no problem', 'of course', 'i see', 'go on', 'go ahead'].map(
	(phrase) => new RegExp(`\\b${phrase}\\b`, 'g'),
)

const singleWordFillers = new Set([
	// disfluencies
	'uh',
	'um',
	'umm',
	'ah',
	'er',
	'hmm',
	'hm',
	'mm',
	'mmm',
	'huh',
	// discourse markers
	'like',
	'so',
	'well',
	'actually',
	'basically',
	'honestly',
	'anyway',
	'anyways',
	// assent / acknowledgment
	'yeah',
	'yea',
	'yep',
	'yup',
	'yes',
	'right',
	'okay',
	'ok',
	'okie',
	'sure',
	'cool',
	'alright',
	'exactly',
	'totally',
	'definitely',
	'gotcha',
	'true',
	'fine',
	'great',
	'perfect',
	'nice',
	'good',
	'wow',
	'oh',
	'aha',
	'mhm',
	'mmhmm',
	'uhhuh',
])

function normalize(text: string): string {
	return (
		text
			.toLowerCase()
			// Fold hyphens/apostrophes into the word so "mm-hmm" → "mmhmm".
			.replace(/[-'’]/g, '')
			.replace(/[^a-z0-9\s]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
	)
}

/**
 * True when `text` contains speech but nothing beyond filler, assent,
 * and acknowledgment tokens. Empty/whitespace-only text returns false —
 * no transcript is not evidence of filler.
 */
export function isFillerOrAssentOnly(text: string): boolean {
	let normalized = normalize(text)
	if (!normalized) return false
	for (const phrase of multiWordFillers) {
		normalized = normalized.replace(phrase, ' ')
	}
	const words = normalized.split(/\s+/).filter((w) => w.length > 0)
	if (words.length === 0) return true
	return words.every((w) => singleWordFillers.has(w))
}
