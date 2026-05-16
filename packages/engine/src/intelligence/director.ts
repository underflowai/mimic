import type OpenAI from 'openai'

import { createLogger } from '#engine/logger.js'

import { sanitizeForTranscript } from '../audio/tts-sanitizer.js'
import { isAbortLikeError } from '../shared/async-utils.js'
import type { CallTurn } from '../shared/prompt-turns.js'
import type { DirectorConfig } from './types.js'

const log = createLogger('mimic:director')

const pauseTagRe = /\[(long-)?pause\]\s*/gi
export type CommittedTurnContent =
	| { kind: 'exchange'; user: string; agent: string }
	| { kind: 'partial_exchange'; user: string; heardAgentPortion: string }
	| { kind: 'greeting'; agent: string }
	| { kind: 'user_only'; user: string }

export interface PendingToolCall {
	id: string
	name: string
	args: Record<string, unknown>
}

function stripPauseTags(text: string) {
	return text.replace(pauseTagRe, '')
}

export function createDirector(cfg: DirectorConfig) {
	const { client, model } = cfg
	const turns: CallTurn[] = []
	const toolHistory: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []

	const maxRecentMessages = cfg.maxRecentMessages ?? 50
	const completionParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model,
		stream: true,
		stream_options: { include_usage: true },
		max_completion_tokens: cfg.maxCompletionTokens ?? 512,
		messages: [],
	}
	if (!model.includes('chat-latest') && !model.startsWith('gpt-5.5')) {
		completionParams.temperature = 0.3
	}

	let conversationSummary: string | null = null

	function setConversationSummary(summary: string, turnsCovered: number) {
		conversationSummary = summary
		log.info({ turnsCovered, summaryLength: summary.length }, 'conversation summary applied')
	}

	function buildMessages(controlBlock: string, transcript: string) {
		const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
			{ role: 'system', content: cfg.systemPrompt },
		]

		let turnsToRender: CallTurn[]

		if (conversationSummary && turns.length > maxRecentMessages) {
			messages.push({ role: 'system', content: `Earlier in this call:\n${conversationSummary}` })
			turnsToRender = turns.slice(-maxRecentMessages)
		} else {
			turnsToRender = turns
		}

		for (const t of turnsToRender) {
			messages.push({
				role: t.role === 'user' ? 'user' : 'assistant',
				content: t.role === 'agent' ? stripPauseTags(t.content) : t.content,
			})
		}

		// Native tool call/result messages are appended after conversation history
		for (const msg of toolHistory) {
			messages.push(msg)
		}

		const isEmptyTranscript = !transcript.trim()

		if (controlBlock) messages.push({ role: 'system', content: controlBlock })

		if (isEmptyTranscript && toolHistory.length > 0) {
			messages.push({
				role: 'user',
				content:
					'[A tool result arrived. Review what you already said. If you already communicated the outcome, respond with just a brief natural closing or silence. Do not restate information.]',
			})
		} else {
			messages.push({ role: 'user', content: transcript })
		}

		return messages
	}

	function logCacheUsage(usage: unknown) {
		if (!usage || typeof usage !== 'object') return
		const u = usage as {
			prompt_tokens?: number
			prompt_tokens_details?: { cached_tokens?: number }
			completion_tokens?: number
		}
		const promptTokens = u.prompt_tokens
		const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? 0
		if (promptTokens) {
			log.info(
				{
					promptTokens,
					cachedTokens,
					completionTokens: u.completion_tokens,
					cacheHitPct: Math.round((cachedTokens / promptTokens) * 100),
				},
				'LLM token usage',
			)
		}
	}

	async function generateDraft(userTranscript: string, controlBlock: string, signal?: AbortSignal) {
		const messages = buildMessages(controlBlock, userTranscript)
		log.info({ priorTurnCount: turns.length, controlBlock }, 'control block')

		let stream: Awaited<ReturnType<typeof client.chat.completions.create>>
		try {
			stream = await client.chat.completions.create({ ...completionParams, messages }, signal ? { signal } : undefined)
		} catch (err) {
			if (signal?.aborted || isAbortLikeError(err)) return null
			throw err
		}

		let fullResponse = ''
		let lastUsage: unknown

		try {
			for await (const chunk of stream) {
				if (signal?.aborted) break
				const delta = chunk.choices[0]?.delta
				if (delta?.content) fullResponse += delta.content
				if (chunk.usage) lastUsage = chunk.usage
			}
		} catch (err) {
			if (signal?.aborted || isAbortLikeError(err)) return null
			throw err
		}

		logCacheUsage(lastUsage)

		if (signal?.aborted) return null
		const trimmed = fullResponse.trim()
		if (!trimmed) {
			log.warn({ userTranscript }, 'LLM returned empty response')
			return null
		}

		return { userTranscript, agentResponse: trimmed }
	}

	function streamDraftTokenized(userTranscript: string, controlBlock: string, signal?: AbortSignal) {
		const messages = buildMessages(controlBlock, userTranscript)
		log.info({ priorTurnCount: turns.length, controlBlock }, 'control block')

		async function* events() {
			let stream: Awaited<ReturnType<typeof client.chat.completions.create>>
			try {
				stream = await client.chat.completions.create(
					{ ...completionParams, messages },
					signal ? { signal } : undefined,
				)
			} catch (err) {
				if (signal?.aborted || isAbortLikeError(err)) return ''
				throw err
			}

			let fullResponse = ''
			let lastUsage: unknown

			try {
				for await (const chunk of stream) {
					if (signal?.aborted) break
					const choice = chunk.choices[0]
					if (!choice) continue

					const token = choice.delta?.content
					if (token) {
						fullResponse += token
						yield { type: 'token' as const, value: token }
					}

					if (chunk.usage) lastUsage = chunk.usage
				}
			} catch (err) {
				if (signal?.aborted || isAbortLikeError(err)) return ''
				throw err
			}

			if (signal?.aborted) return ''
			logCacheUsage(lastUsage)

			return fullResponse.trim()
		}

		return { userTranscript, events: events() }
	}

	function commitTurn(content: CommittedTurnContent) {
		if (content.kind === 'exchange') {
			turns.push({ role: 'user', content: content.user })
			turns.push({ role: 'agent', content: sanitizeForTranscript(content.agent) })
			return
		}
		if (content.kind === 'partial_exchange') {
			turns.push({ role: 'user', content: content.user })
			if (content.heardAgentPortion) {
				turns.push({ role: 'agent', content: `${sanitizeForTranscript(content.heardAgentPortion)}—` })
			}
			return
		}
		if (content.kind === 'greeting') {
			turns.push({ role: 'agent', content: sanitizeForTranscript(content.agent) })
			return
		}
		turns.push({ role: 'user', content: content.user })
	}

	function commitToolCall(toolCall: PendingToolCall) {
		const lastMsg = toolHistory[toolHistory.length - 1]
		if (lastMsg && lastMsg.role === 'assistant' && Array.isArray((lastMsg as { tool_calls?: unknown[] }).tool_calls)) {
			;(lastMsg as { tool_calls: unknown[] }).tool_calls.push({
				id: toolCall.id,
				type: 'function',
				function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
			})
		} else {
			toolHistory.push({
				role: 'assistant',
				content: null,
				tool_calls: [
					{
						id: toolCall.id,
						type: 'function',
						function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
					},
				],
			} as OpenAI.Chat.Completions.ChatCompletionMessageParam)
		}
	}

	function commitToolResult(callId: string, result: string) {
		toolHistory.push({
			role: 'tool',
			tool_call_id: callId,
			content: result,
		} as OpenAI.Chat.Completions.ChatCompletionMessageParam)
	}

	function listTurns() {
		return turns.filter((t) => t.content.trim().length > 0)
	}

	function needsSummary() {
		return turns.length > maxRecentMessages && !conversationSummary
	}

	function getOlderTurnsForSummary() {
		if (turns.length <= maxRecentMessages) return null
		return turns.slice(0, turns.length - maxRecentMessages)
	}

	return {
		generateDraft,
		streamDraftTokenized,
		commitTurn,
		commitToolCall,
		commitToolResult,
		listTurns,
		setConversationSummary,
		needsSummary,
		getOlderTurnsForSummary,
	}
}

export type Director = ReturnType<typeof createDirector>
