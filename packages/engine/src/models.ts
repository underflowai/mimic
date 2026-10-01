/**
 * Model registry — the single place a model name appears, for the engine and
 * for the server (goal compiler, result extractor).
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

/**
 * `chat-latest` is the floating alias for the model behind ChatGPT Instant. It
 * is a non-reasoning model: it rejects `temperature` and every
 * `reasoning_effort` other than its default, so specs that use it carry no
 * effort. OpenAI may repoint the alias without notice.
 *
 * It is used across the in-call paths. A compact-prompt eval on 2026-09-30
 * found `gpt-6.1-sol` low higher quality than chat-latest (9.31 vs 8.78,
 * paired-bootstrap P[better] 99.4%), but slower: director TTFT p50/p95 was
 * 1,399ms/2,123ms versus chat-latest's 753ms/1,487ms. The director uses
 * chat-latest to prioritize live-call latency.
 */
export const models: {
	director: { openai: ModelSpec; anthropic: ModelSpec }
	background: ModelSpec
	webSearch: ModelSpec
	toolWatcher: ModelSpec & { maxOutputTokens: number }
	goalCompiler: ModelSpec & { maxOutputTokens: number }
	resultExtractor: ModelSpec
} = {
	/** The voice director — the model that talks to the caller. */
	director: {
		openai: { model: 'chat-latest' },
		anthropic: { model: 'claude-haiku-4-5' },
	},
	/** Small background work: backchannel and promotion classifiers, entity extraction, summaries. */
	background: { model: 'chat-latest' },
	/** Live web search via the Responses API `web_search` tool. */
	webSearch: { model: 'chat-latest' },
	/** Tool intent + argument extraction (Responses API, strict JSON schema). */
	toolWatcher: { model: 'chat-latest', maxOutputTokens: 512 },
	/**
	 * Compiles a developer goal into the agent's prompt (server). Runs once per agent
	 * config, so quality over speed. Reasoning tokens count against the output ceiling.
	 */
	goalCompiler: { model: 'gpt-6.1-sol', reasoningEffort: 'high', maxOutputTokens: 32_000 },
	/** Post-call result extraction (server). Not latency-sensitive. */
	resultExtractor: { model: 'gpt-6.1-sol', reasoningEffort: 'low' },
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
