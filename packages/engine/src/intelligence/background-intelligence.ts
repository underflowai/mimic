/**
 * Background Intelligence
 *
 * Owns all post-commit background LLM work: entity extraction
 * → keyterm updates, and conversation summarization.
 *
 * Concurrency model:
 *  - one `PQueue` (concurrency 6) runs every background model call;
 *  - summarization is additionally coalesced so at most one summary is in
 *    flight and repeated requests collapse into a single follow-up run.
 *
 * Each task is a tiny focused prompt (~20-300 token output) for fast
 * turnaround. They run in parallel rather than bundled in one large prompt.
 */

import type OpenAI from 'openai'
import PQueue from 'p-queue'
import { z } from 'zod'

import { callBackgroundModel } from '#engine/llm-parse.js'
import { createLogger } from '#engine/logger.js'
import { loadPrompt } from '#engine/prompts.js'

import type { FluxConfigureOptions } from '../audio/types.js'
import { formatTurnsForPrompt, type CallTurn } from '../shared/prompt-turns.js'
import { coalesceRuns } from '../shared/task.js'

const log = createLogger('mimic:intel')

const entitySchema = z.object({
	entities: z.array(z.string().min(2)).max(50),
})

const summarySchema = z.object({
	summary: z.string(),
})

interface PostCommitInput {
	userTranscript: string
	agentResponse: string
}

export interface BackgroundIntelligenceDeps {
	client: OpenAI
	callSignal: AbortSignal
	/** The voice agent's name, used to label its lines in prompts. */
	agentName: string
	transcriber: { configure: (opts: FluxConfigureOptions) => void }
	director: {
		listTurns: () => CallTurn[]
		needsSummary: () => boolean
		getOlderTurnsForSummary: () => CallTurn[] | null
		setConversationSummary: (summary: string, turnsCovered: number) => void
	}
}

const backgroundQueueConcurrency = 6
/** Deepgram Flux accepts at most this many keyterms per Configure message. */
const maxKeytermCount = 100

let cachedPrompts: Promise<{ entityExtraction: string; conversationSummary: string }> | null = null
function getPrompts() {
	cachedPrompts ??= Promise.all([
		loadPrompt('instructions/entity-extraction'),
		loadPrompt('instructions/conversation-summary'),
	]).then(([entityExtraction, conversationSummary]) => ({ entityExtraction, conversationSummary }))
	return cachedPrompts
}

export function createBackgroundIntelligence(deps: BackgroundIntelligenceDeps) {
	const { client, agentName } = deps
	const accumulatedKeyterms = new Set<string>()
	const queue = new PQueue({ concurrency: backgroundQueueConcurrency })

	function callIsActive() {
		return !deps.callSignal.aborted
	}

	async function extractEntitiesAndUpdateKeyterms(userTranscript: string, agentResponse: string) {
		if (!callIsActive()) return
		try {
			const prompts = await getPrompts()
			const parsed = await callBackgroundModel(
				client,
				prompts.entityExtraction,
				`${agentName}: "${agentResponse}"\nCaller: "${userTranscript}"`,
				entitySchema,
				'keyterms',
				{ signal: deps.callSignal },
			)
			if (!callIsActive()) return
			if (parsed) {
				for (const e of parsed.entities) accumulatedKeyterms.add(e)
				deps.transcriber.configure({ keyterms: [...accumulatedKeyterms].slice(0, maxKeytermCount) })
				log.info({ keyterms: [...accumulatedKeyterms] }, 'keyterms updated')
			}
		} catch (err) {
			if (!callIsActive()) return
			log.error({ err }, 'entity extraction failed')
		}
	}

	async function summarizeConversation() {
		if (!callIsActive()) return
		if (!deps.director.needsSummary()) return

		const olderTurns = deps.director.getOlderTurnsForSummary()
		if (!olderTurns || olderTurns.length === 0) return

		try {
			const prompts = await getPrompts()
			const parsed = await callBackgroundModel(
				client,
				prompts.conversationSummary,
				formatTurnsForPrompt(olderTurns, { agentLabel: agentName }),
				summarySchema,
				'conversation-summary',
				{ maxTokens: 300, signal: deps.callSignal },
			)

			if (!callIsActive() || !parsed?.summary) return

			deps.director.setConversationSummary(parsed.summary, olderTurns.length)
			log.info({ turnsCovered: olderTurns.length }, 'conversation summary generated')
		} catch (err) {
			if (!callIsActive()) return
			log.error({ err }, 'conversation summary failed')
		}
	}

	const scheduleSummary = coalesceRuns(
		() => queue.add(() => summarizeConversation()),
		(err) => log.error({ err }, 'conversation summary scheduling failed'),
	)

	/** Kick off the background work for a committed turn. Fire-and-forget; failures are logged. */
	function runPostCommitTasks(input: PostCommitInput) {
		if (!callIsActive()) return
		void queue.add(() => extractEntitiesAndUpdateKeyterms(input.userTranscript, input.agentResponse))
		scheduleSummary()
	}

	function addKeyterms(terms: string[]) {
		for (const t of terms) accumulatedKeyterms.add(t)
	}

	async function drain() {
		await queue.onIdle()
	}

	return {
		runPostCommitTasks,
		addKeyterms,
		drain,
	}
}

export type BackgroundIntelligence = ReturnType<typeof createBackgroundIntelligence>
