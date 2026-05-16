import { createHash } from 'node:crypto'

import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'

import { getDb } from '../db/index.js'
import { apiAgents, apiCalls } from '../db/schema.js'
import { compileGoal } from '../goal-compiler.js'
import { enqueueCall } from '../jobs/queue.js'
import { incrementActiveCalls } from '../middleware/rate-limit.js'

function hashPromptConfig(apiKeyId: string, config: { goal: string; voice: string; context?: string; data?: Record<string, unknown>; tools: unknown[]; results: unknown; aiDisclosure?: boolean }): string {
	const dataKeys = config.data ? Object.keys(config.data).sort() : []
	const payload = JSON.stringify({ apiKeyId, goal: config.goal, context: config.context, dataKeys, tools: config.tools, results: config.results, aiDisclosure: config.aiDisclosure })
	return createHash('sha256').update(payload).digest('hex')
}

const calls = new Hono()

calls.post('/', async (c) => {
	const apiKey = c.get('apiKey')
	const body = await c.req.json<{
		to: string
		goal: string
		agentId?: string
		voice?: 'female' | 'male'
		context?: string
		data?: Record<string, unknown>
		recipient?: { firstName: string; lastName?: string; email?: string }
		aiDisclosure?: boolean
		tools?: Array<{ name: string; description: string; parameters: Record<string, string> }>
		results?: Record<string, unknown>
		extract?: Record<string, unknown>
		ambience?: boolean
		idempotencyKey?: string
	}>()

	if (!body.to?.trim()) return c.json({ error: 'to (phone number) is required' }, 400)

	const db = getDb()

	if (body.idempotencyKey) {
		const [existing] = await db
			.select()
			.from(apiCalls)
			.where(and(eq(apiCalls.apiKeyId, apiKey.id), eq(apiCalls.idempotencyKey, body.idempotencyKey)))
			.limit(1)
		if (existing) return c.json({ id: existing.id, status: existing.status })
	}

	let agentId: string
	let needsCompilation = false

	if (body.agentId) {
		const [existing] = await db
			.select()
			.from(apiAgents)
			.where(and(eq(apiAgents.id, body.agentId), eq(apiAgents.apiKeyId, apiKey.id)))
			.limit(1)
		if (!existing) return c.json({ error: 'Agent not found' }, 404)
		agentId = existing.id
	} else {
		if (!body.goal?.trim()) return c.json({ error: 'goal is required' }, 400)

		const voice = body.voice ?? 'female'
		const tools = (body.tools ?? []).map((t) => ({
			...t,
			kind: 'read' as const,
			parameters: t.parameters ?? {},
		}))
		const results = body.results ?? body.extract ?? {}

		const configHash = hashPromptConfig(apiKey.id, {
			goal: body.goal,
			voice,
			context: body.context,
			data: body.data,
			tools,
			results,
			aiDisclosure: body.aiDisclosure,
		})

		const [cached] = await db
			.select()
			.from(apiAgents)
			.where(and(eq(apiAgents.apiKeyId, apiKey.id), eq(apiAgents.configHash, configHash)))
			.limit(1)

		if (cached) {
			agentId = cached.id
		} else {
			// Create a placeholder agent row — compile in background
			const [placeholder] = await db
				.insert(apiAgents)
				.values({
					apiKeyId: apiKey.id,
					name: body.goal.slice(0, 80) || 'voice agent',
					goal: body.goal,
					voice,
					context: body.context ?? '',
					tools,
					results,
					configHash,
					systemPrompt: '',
					agentName: voice === 'male' ? 'Arlo' : 'Aurora',
					ambience: body.ambience ?? true,
				})
				.returning()
			agentId = placeholder.id
			needsCompilation = true
		}
	}

	const callContext: Record<string, string> = {}
	if (body.recipient?.firstName) callContext.firstName = body.recipient.firstName
	if (body.recipient?.lastName) callContext.lastName = body.recipient.lastName
	if (body.recipient?.email) callContext.email = body.recipient.email

	const [call] = await db
		.insert(apiCalls)
		.values({
			apiKeyId: apiKey.id,
			agentId,
			toPhone: body.to,
			callContext,
			idempotencyKey: body.idempotencyKey ?? null,
		})
		.returning()

	if (!incrementActiveCalls(apiKey.id)) {
		return c.json({ error: 'Concurrent call limit reached. Wait for active calls to complete.' }, 429)
	}

	// Compile goal in background if needed, then enqueue the call job
	void (async () => {
		try {
			if (needsCompilation) {
				const compiled = await compileGoal({
					goal: body.goal!,
					voice: body.voice ?? 'female',
					context: body.context ?? '',
					data: body.data,
					recipient: body.recipient,
					tools: (body.tools ?? []).map((t) => ({ ...t, kind: 'read' as const, parameters: t.parameters ?? {} })),
					results: body.results ?? body.extract ?? {},
					aiDisclosure: body.aiDisclosure,
				})

				await db.update(apiAgents).set({
					systemPrompt: compiled.systemPrompt,
					turnControlBlock: compiled.turnControlBlock ?? null,
					agentName: compiled.agentName,
				}).where(eq(apiAgents.id, agentId))
			}

			await enqueueCall({ callId: call.id, agentId })
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err)
			await db.update(apiCalls).set({ status: 'failed', errorMessage }).where(eq(apiCalls.id, call.id)).catch(() => {})
		}
	})()

	return c.json({ id: call.id, status: call.status }, 201)
})

calls.get('/:id', async (c) => {
	const apiKey = c.get('apiKey')
	const db = getDb()

	const [call] = await db
		.select()
		.from(apiCalls)
		.where(and(eq(apiCalls.id, c.req.param('id')), eq(apiCalls.apiKeyId, apiKey.id)))
		.limit(1)

	if (!call) return c.json({ error: 'Call not found' }, 404)

	return c.json({
		id: call.id,
		status: call.status,
		transcript: call.transcript,
		result: call.result,
		goalAchieved: call.goalAchieved,
		goalAchievedReason: call.goalAchievedReason,
		duration: call.duration,
		errorMessage: call.errorMessage,
		recordingPath: call.recordingPath,
	})
})

export { calls }
