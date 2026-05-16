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
}

// ── Re-exports ───────────────────────────────────────────────────────

export type { BackgroundIntelligence } from './background-intelligence.js'
export type { Director, PendingToolCall } from './director.js'
