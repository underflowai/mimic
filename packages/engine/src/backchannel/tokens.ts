/**
 * The backchannel vocabulary, shared by the classifier (what the model may
 * pick), the clip loader (what must exist on disk), and the clip generator.
 */

export const backchannelTokens = ['mm-hmm', 'uh-huh', 'yeah', 'right', 'sure', 'got-it', 'i-see', 'okay'] as const

export type BackchannelToken = (typeof backchannelTokens)[number]

/**
 * Caller transcripts shorter than this are never backchanneled. Shared by the
 * engine's gate and the classifier's short-circuit so the two can't drift.
 */
export const minBackchannelWords = 4
