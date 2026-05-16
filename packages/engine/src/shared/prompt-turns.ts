export interface CallTurn {
	role: 'user' | 'agent'
	content: string
}

export interface FormatTurnsOptions {
	limit?: number
	agentLabel?: string
	callerLabel?: string
}

/**
 * Renders the running transcript for LLM prompts.
 *
 * The agent label is explicit so prompts match the active persona (Aurora,
 * Arlo, ...). Defaults exist for tests and ad-hoc callers, but production
 * callers should pass the persona's firstName.
 */
export function formatTurnsForPrompt(turns: CallTurn[], optionsOrLimit?: number | FormatTurnsOptions) {
	const options: FormatTurnsOptions =
		typeof optionsOrLimit === 'number' ? { limit: optionsOrLimit } : (optionsOrLimit ?? {})
	const agentLabel = options.agentLabel ?? 'Agent'
	const callerLabel = options.callerLabel ?? 'Caller'
	const sliced = options.limit ? turns.slice(-options.limit) : turns
	return sliced.map((t) => `${t.role === 'user' ? callerLabel : agentLabel}: "${t.content}"`).join('\n')
}
