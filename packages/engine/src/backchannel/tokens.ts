/**
 * The backchannel vocabulary, shared by the classifier (what the model may
 * pick), the clip loader (what must exist on disk), and the clip generator.
 */

export const backchannelTokens = ['mm-hmm', 'uh-huh', 'yeah', 'right', 'sure', 'got-it', 'i-see', 'okay'] as const

export type BackchannelToken = (typeof backchannelTokens)[number]

/**
 * The subset the classifier may pick: tokens that signal listening without
 * sounding like agreement or permission. "yeah", "right", "sure", and "okay"
 * have clips but are never chosen automatically — mid-sentence they read as
 * consent to whatever the caller is saying.
 */
export const neutralBackchannelTokens = [
	'mm-hmm',
	'uh-huh',
	'got-it',
	'i-see',
] as const satisfies readonly BackchannelToken[]

/**
 * Caller transcripts shorter than this are never backchanneled. Shared by the
 * engine's gate and the classifier's short-circuit so the two can't drift.
 */
export const minBackchannelWords = 4
