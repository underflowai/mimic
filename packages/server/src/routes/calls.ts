import { createHash } from 'node:crypto'

import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'

import { getDb } from '../db/index.js'
import { apiAgents, apiCalls } from '../db/schema.js'
import { compileGoal } from '../goal-compiler.js'
import { runCall } from '../call-runner.js'

function hashPromptConfig(apiKeyId: string, goal: string, voice: string, context: unknown, tools: unknown[], results: unknown): string {
	const payload = JSON.stringify({ apiKeyId, goal, voice, context, tools, results })
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
		context?: Record<string, string>
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
		const configHash = hashPromptConfig(apiKey.id, body.goal, voice, body.context ?? {}, tools, results)

		const [cached] = await db
			.select()
			.from(apiAgents)
			.where(and(eq(apiAgents.apiKeyId, apiKey.id), eq(apiAgents.configHash, configHash)))
			.limit(1)

		if (cached) {
			agentId = cached.id
		} else {
			const compiled = await compileGoal({ goal: body.goal, voice, context: body.context ?? {}, tools, results })

			const [agent] = await db
				.insert(apiAgents)
				.values({
					apiKeyId: apiKey.id,
					name: body.goal.slice(0, 80) || 'voice agent',
					goal: body.goal,
					voice,
					context: body.context ?? {},
					tools,
					results,
					configHash,
					systemPrompt: compiled.systemPrompt,
					turnControlBlock: compiled.turnControlBlock ?? null,
					agentName: compiled.agentName,
					ambience: body.ambience ?? true,
				})
				.returning()
			agentId = agent.id
		}
	}

	const [agent] = await db.select().from(apiAgents).where(eq(apiAgents.id, agentId)).limit(1)

	const [call] = await db
		.insert(apiCalls)
		.values({
			apiKeyId: apiKey.id,
			agentId,
			toPhone: body.to,
			callContext: body.context ?? {},
			idempotencyKey: body.idempotencyKey ?? null,
		})
		.returning()

	void runCall(call, agent!)

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
	})
})

export { calls }
