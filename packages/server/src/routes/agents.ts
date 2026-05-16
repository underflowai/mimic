import { Hono } from 'hono'

import { getDb } from '../db/index.js'
import { apiAgents } from '../db/schema.js'
import { compileGoal } from '../goal-compiler.js'

const agents = new Hono()

agents.post('/', async (c) => {
	const apiKey = c.get('apiKey')
	const body = await c.req.json<{
		name?: string
		goal: string
		voice?: 'female' | 'male'
		context?: Record<string, string>
		tools?: Array<{ name: string; description: string; parameters: Record<string, string> }>
		results?: Record<string, unknown>
		successCondition?: { type: string; toolName?: string; fieldName?: string }
		webhook?: string
	}>()

	if (!body.goal?.trim()) {
		return c.json({ error: 'goal is required' }, 400)
	}

	const voice = body.voice ?? 'female'
	const tools = (body.tools ?? []).map((t) => ({
		...t,
		kind: 'read' as const,
		parameters: t.parameters ?? {},
	}))

	const compiled = await compileGoal({
		goal: body.goal,
		voice,
		context: body.context ?? {},
		tools,
		results: body.results ?? {},
	})

	const db = getDb()
	const [agent] = await db
		.insert(apiAgents)
		.values({
			apiKeyId: apiKey.id,
			name: body.name ?? (body.goal.slice(0, 80) || 'voice agent'),
			goal: body.goal,
			voice,
			context: body.context ?? {},
			tools,
			results: body.results ?? {},
			systemPrompt: compiled.systemPrompt,
			turnControlBlock: compiled.turnControlBlock ?? null,
			agentName: compiled.agentName,
			webhook: body.webhook ?? null,
			successCondition: body.successCondition ?? null,
		})
		.returning()

	return c.json({
		id: agent.id,
		name: agent.name,
		goal: agent.goal,
		voice: agent.voice,
		context: agent.context,
		tools: agent.tools,
		results: agent.results,
	}, 201)
})

agents.get('/:id', async (c) => {
	const apiKey = c.get('apiKey')
	const db = getDb()
	const { eq, and } = await import('drizzle-orm')

	const [agent] = await db
		.select()
		.from(apiAgents)
		.where(and(eq(apiAgents.id, c.req.param('id')), eq(apiAgents.apiKeyId, apiKey.id)))
		.limit(1)

	if (!agent) return c.json({ error: 'Agent not found' }, 404)

	return c.json({
		id: agent.id,
		name: agent.name,
		goal: agent.goal,
		voice: agent.voice,
		context: agent.context,
		tools: agent.tools,
		results: agent.results,
	})
})

export { agents }
