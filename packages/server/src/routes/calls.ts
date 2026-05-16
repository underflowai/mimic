import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'

import { getDb } from '../db/index.js'
import { apiAgents, apiCalls } from '../db/schema.js'
import { runCall } from '../call-runner.js'

const calls = new Hono()

calls.post('/', async (c) => {
	const apiKey = c.get('apiKey')
	const body = await c.req.json<{
		agentId: string
		to: string
		context?: Record<string, string>
		idempotencyKey?: string
	}>()

	if (!body.agentId?.trim()) return c.json({ error: 'agentId is required' }, 400)
	if (!body.to?.trim()) return c.json({ error: 'to (phone number) is required' }, 400)

	const db = getDb()

	const [agent] = await db
		.select()
		.from(apiAgents)
		.where(and(eq(apiAgents.id, body.agentId), eq(apiAgents.apiKeyId, apiKey.id)))
		.limit(1)

	if (!agent) return c.json({ error: 'Agent not found' }, 404)

	if (body.idempotencyKey) {
		const [existing] = await db
			.select()
			.from(apiCalls)
			.where(and(eq(apiCalls.apiKeyId, apiKey.id), eq(apiCalls.idempotencyKey, body.idempotencyKey)))
			.limit(1)
		if (existing) return c.json({ id: existing.id, status: existing.status })
	}

	const [call] = await db
		.insert(apiCalls)
		.values({
			apiKeyId: apiKey.id,
			agentId: body.agentId,
			toPhone: body.to,
			callContext: body.context ?? {},
			idempotencyKey: body.idempotencyKey ?? null,
		})
		.returning()

	void runCall(call, agent)

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
