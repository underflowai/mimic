import type OpenAI from 'openai'
export type { EagerAudioSink } from '../shared/streaming-types.js'

export interface InterruptContext {
	fullDraft: string
	sentMs: number
	heardPortion: string
}

export interface DirectorConfig {
	client: OpenAI
	model: string
	systemPrompt: string
	maxRecentMessages?: number
	maxCompletionTokens?: number
	/**
	 * Provider supports the OpenAI predicted-outputs parameter. When set,
	 * racing-fresh generations pass the eager draft as a prediction so
	 * regeneration is fast exactly when it agrees with the draft.
	 */
	supportsPredictedOutputs?: boolean
}

// ── Re-exports ───────────────────────────────────────────────────────

export type { BackgroundIntelligence } from './background-intelligence.js'
export type { Director, PendingToolCall } from './director.js'
