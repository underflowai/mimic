export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high'

export interface OpenAIConfig {
	model: string
	maxTokens: number
	reasoningEffort?: ReasoningEffort
}

export type ModelConfigKey = 'toolWatcher'

export const modelConfig = {
	/** Tool intent + argument extraction (Responses API, strict JSON schema). */
	toolWatcher: {
		// Eval 2026-09-30 vs gpt-5.5 (low): p50 2363ms vs 3439ms, p95 2944ms vs 6216ms (8s timeout),
		// same accuracy, ~1/50th the price. `low` kept for the WRITE-tool verification rules.
		model: 'gpt-6-luna',
		maxTokens: 512,
		reasoningEffort: 'low' as const,
	},
} as const

export function getOpenAIConfig(key: ModelConfigKey): OpenAIConfig {
	return modelConfig[key]
}

/**
 * Whether OpenAI accepts `temperature` for this model at this reasoning effort.
 *
 * Measured 2026-09-30 across the GPT-5.4 → GPT-6.1 families: every model
 * rejects `temperature` when `reasoning_effort` is `low` or higher, and so does
 * the `chat-latest` alias. Models running at `none` (or with no effort sent,
 * e.g. gpt-5.4-mini) accept it.
 */
export function supportsTemperature(model: string, reasoningEffort?: ReasoningEffort) {
	if (model.includes('chat-latest')) return false
	if (reasoningEffort && reasoningEffort !== 'none') return false
	// gpt-5.5 defaults to reasoning when no effort is sent.
	if (!reasoningEffort && model.startsWith('gpt-5.5')) return false
	return true
}
