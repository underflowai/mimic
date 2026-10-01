import type OpenAI from 'openai'

import type { ReasoningEffort } from '../models.js'
export type { EagerAudioSink } from '../shared/streaming-types.js'

/** What the agent was saying when the caller cut in. */
export interface InterruptContext {
	/** The full response the agent was delivering (transcript-sanitized). */
	fullDraft: string
	/** Agent audio handed to the transport before the interrupt. */
	sentMs: number
	/** Agent audio that actually reached the caller before the interrupt. */
	playedMs: number
	/** The part of `fullDraft` the caller heard, snapped to a clause boundary. */
	heardPortion: string
}

export interface DirectorConfig {
	client: OpenAI
	model: string
	reasoningEffort?: ReasoningEffort
	systemPrompt: string
	maxRecentMessages?: number
	maxCompletionTokens?: number
}

// ── Re-exports ───────────────────────────────────────────────────────

export type { BackgroundIntelligence } from './background-intelligence.js'
export type { Director, PendingToolCall } from './director.js'
