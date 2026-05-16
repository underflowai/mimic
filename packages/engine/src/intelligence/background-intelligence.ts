/**
 * Background Intelligence
 *
 * Owns all post-commit background LLM work: entity extraction
 * → keyterm updates and conversation summarization.
 *
 * Concurrency model:
 *  - `postCommitQueue` (concurrency 1) — serializes runPostCommitTasks invocations.
 *  - `queue` (concurrency 6) — all background model classifiers, entity extraction
 *    run in parallel.
 *
 * Each classifier is a tiny focused prompt (~20-100 token output) for fast
 * turnaround. They run in parallel rather than bundled in one large prompt.
 */

import type OpenAI from 'openai'
import PQueue from 'p-queue'
import { assign, createActor, fromPromise, setup } from 'xstate'
import { z } from 'zod'

import { createLogger } from '#engine/logger.js'

import { callBackgroundModel } from '#engine/llm-parse.js'
import type { FluxConfigureOptions } from '../audio/types.js'
import type { CallTurn } from '../shared/prompt-turns.js'
import { singleFlight } from '../shared/task.js'

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
	transcriber: { configure: (opts: FluxConfigureOptions) => void }
	director: {
		listTurns: () => CallTurn[]
		needsSummary: () => boolean
		getOlderTurnsForSummary: () => CallTurn[] | null
		setConversationSummary: (summary: string, turnsCovered: number) => void
	}
}

const backgroundQueueConcurrency = 6
const maxKeytermCount = 100

export function createBackgroundIntelligence(deps: BackgroundIntelligenceDeps) {
	const client = deps.client
	const accumulatedKeyterms = new Set<string>()
	const queue = new PQueue({ concurrency: backgroundQueueConcurrency })
	const postCommitQueue = new PQueue({ concurrency: 1 })

	function callIsActive() {
		return !deps.callSignal.aborted
	}

	const runSummarySingleFlight = singleFlight(async () => {
		await queue.add(() => summarizeConversation())
	})

	async function extractEntitiesAndUpdateKeyterms(userTranscript: string, agentResponse: string) {
		if (!callIsActive()) return
		try {
			const parsed = await callBackgroundModel(
				client,
				'Extract all proper nouns from this exchange: company names, people names, cities, states, product names. Return JSON: {"entities": ["name1", "name2"]}',
				`Aurora: "${agentResponse}"\nCaller: "${userTranscript}"`,
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
			const formatted = olderTurns.map((t) => `${t.role === 'user' ? 'Caller' : 'Aurora'}: "${t.content}"`).join('\n')

			const parsed = await callBackgroundModel(
				client,
				'Summarize this voice call conversation concisely. Capture the key facts: who the caller is, what they do, what they said, what the agent learned, and any commitments made. Write 3-5 sentences in third person past tense. Do not include speech tags or filler words. Return JSON: {"summary": "..."}',
				formatted,
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

	const summarySchedulerSetup = setup({
		types: {
			context: {} as { queued: boolean },
			events: {} as { type: 'request_summary' },
		},
		actors: {
			runSummary: fromPromise(async () => {
				await runSummarySingleFlight()
			}),
		},
	})

	const summarySchedulerMachine = summarySchedulerSetup.createMachine({
		id: 'summary-scheduler',
		initial: 'idle',
		context: { queued: false },
		states: {
			idle: {
				on: {
					request_summary: { target: 'running', actions: assign({ queued: false }) },
				},
			},
			running: {
				invoke: {
					src: 'runSummary',
					onDone: [
						{
							guard: ({ context }) => context.queued && callIsActive(),
							target: 'running',
							actions: assign({ queued: false }),
						},
						{ target: 'idle', actions: assign({ queued: false }) },
					],
					onError: [
						{
							guard: ({ context }) => context.queued && callIsActive(),
							target: 'running',
							actions: assign({ queued: false }),
						},
						{ target: 'idle', actions: assign({ queued: false }) },
					],
				},
				on: {
					request_summary: {
						actions: assign({ queued: true }),
					},
				},
			},
		},
	})

	const summaryScheduler = createActor(summarySchedulerMachine).start()

	function scheduleSummary() {
		summaryScheduler.send({ type: 'request_summary' })
	}

	function schedulePostCommitFollowUps(userTranscript: string, agentResponse: string) {
		queue.add(() => extractEntitiesAndUpdateKeyterms(userTranscript, agentResponse))
		scheduleSummary()
	}

	async function runPostCommitTasksInner(input: PostCommitInput) {
		if (!callIsActive()) return
		schedulePostCommitFollowUps(input.userTranscript, input.agentResponse)
	}

	function runPostCommitTasks(input: PostCommitInput) {
		return postCommitQueue.add(() => runPostCommitTasksInner(input))
	}

	function addKeyterms(terms: string[]) {
		for (const t of terms) accumulatedKeyterms.add(t)
	}

	async function drain() {
		await Promise.all([postCommitQueue.onIdle(), queue.onIdle()])
	}

	return {
		runPostCommitTasks,
		addKeyterms,
		drain,
	}
}

export type BackgroundIntelligence = ReturnType<typeof createBackgroundIntelligence>
