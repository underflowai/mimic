/**
 * Model registry — the single place a model name appears.
 *
 * Call sites import from here so a model swap is one edit. The director model
 * is a default only; `CallOrchestratorConfig.directorModel` overrides it per
 * call. Choices and the numbers behind them come from the 2026-09-30 eval.
 */

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high'

export interface ModelSpec {
	model: string
	/** Sent as `reasoning_effort`. Omitted for models that are not run with reasoning (e.g. gpt-5.4-mini). */
	reasoningEffort?: ReasoningEffort
	/** Output-token ceiling for call sites that bound the reply. */
	maxOutputTokens?: number
}

export const models = {
	/** The voice director — the model that talks to the caller. */
	director: {
		// Eval 2026-09-30 vs chat-latest (12 scenarios × 3 runs): TTFT p50 533ms vs 823ms,
		// p95 1191ms vs 2013ms, same brief adherence, pinned snapshot, ~1/50th the price.
		openai: { model: 'gpt-6-luna', reasoningEffort: 'low' },
		anthropic: { model: 'claude-haiku-4-5' },
	},
	/**
	 * Small, fast background work: backchannel and promotion classifiers, entity extraction, summaries.
	 * Fastest model measured for 50-token JSON (p50 ~500ms); every `low` config was slower and less
	 * accurate. Pinned so classifier behaviour can't drift under us; explicit `none` tightens p95
	 * (1553ms → 973ms).
	 */
	background: { model: 'gpt-5.4-mini-2026-03-17', reasoningEffort: 'none' },
	/** Live web search via the Responses API `web_search` tool. */
	webSearch: { model: 'gpt-5.4-mini' },
	/**
	 * Tool intent + argument extraction (Responses API, strict JSON schema).
	 * Eval 2026-09-30 vs gpt-5.5 (low): p50 2363ms vs 3439ms, p95 2944ms vs 6216ms (8s timeout),
	 * same accuracy, ~1/50th the price. `low` kept for the WRITE-tool verification rules.
	 */
	toolWatcher: { model: 'gpt-6-luna', reasoningEffort: 'low', maxOutputTokens: 512 },
} as const satisfies Record<string, ModelSpec | Record<string, ModelSpec>>

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
