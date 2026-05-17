import { createHash } from 'node:crypto'

import { Hono } from 'hono'
import { and, eq, or, sql } from 'drizzle-orm'

import { publishCallEvent } from '../call-runner.js'
import { getDb } from '../db/index.js'
import { apiAgents, apiCalls, type ApiCallRow } from '../db/schema.js'
import { compileGoal } from '../goal-compiler.js'
import { cancelQueuedCall, enqueueCall } from '../jobs/queue.js'
import { MAX_CONCURRENT_CALLS } from '../middleware/rate-limit.js'

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(',')}]`
	}
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

function hashPromptConfig(apiKeyId: string, config: { goal: string; voice: string; context?: string; data?: Record<string, unknown>; tools: unknown[]; results: unknown; aiDisclosure?: boolean; ambience?: boolean }): string {
	const payload = stableStringify({
		apiKeyId,
		goal: config.goal,
		voice: config.voice,
		context: config.context ?? '',
		data: config.data ?? null,
		tools: config.tools,
		results: config.results,
		aiDisclosure: config.aiDisclosure,
		ambience: config.ambience,
	})
	return createHash('sha256').update(payload).digest('hex')
}

const calls = new Hono()

calls.post('/', async (c) => {
	const apiKey = c.get('apiKey')
	let body: {
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
	}
	try {
		body = await c.req.json<typeof body>()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

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
			ambience: body.ambience,
		})

		const [cached] = await db
			.select()
			.from(apiAgents)
			.where(and(
				eq(apiAgents.apiKeyId, apiKey.id),
				eq(apiAgents.configHash, configHash),
				sql`${apiAgents.systemPrompt} <> ''`,
			))
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

	const [concurrencyRow] = await db
		.select({ activeCalls: sql<number>`count(*)::int` })
		.from(apiCalls)
		.where(and(
			eq(apiCalls.apiKeyId, apiKey.id),
			or(eq(apiCalls.status, 'pending'), eq(apiCalls.status, 'in_progress')),
		))

	if ((concurrencyRow?.activeCalls ?? 0) >= MAX_CONCURRENT_CALLS) {
		return c.json({ error: 'Concurrent call limit reached. Wait for active calls to complete.' }, 429)
	}

	let call: ApiCallRow | null = null
	if (body.idempotencyKey) {
		const [inserted] = await db
			.insert(apiCalls)
			.values({
				apiKeyId: apiKey.id,
				agentId,
				toPhone: body.to,
				callContext,
				idempotencyKey: body.idempotencyKey,
			})
			.onConflictDoNothing({ target: [apiCalls.apiKeyId, apiCalls.idempotencyKey] })
			.returning()
		if (inserted) {
			call = inserted
		} else {
			const [existing] = await db
				.select()
				.from(apiCalls)
				.where(and(eq(apiCalls.apiKeyId, apiKey.id), eq(apiCalls.idempotencyKey, body.idempotencyKey)))
				.limit(1)
			if (!existing) {
				return c.json({ error: 'Failed to create idempotent call' }, 500)
			}
			return c.json({ id: existing.id, status: existing.status }, 200)
		}
	} else {
		const [inserted] = await db
			.insert(apiCalls)
			.values({
				apiKeyId: apiKey.id,
				agentId,
				toPhone: body.to,
				callContext,
				idempotencyKey: null,
			})
			.returning()
		call = inserted
	}

	if (!call) {
		return c.json({ error: 'Failed to create call' }, 500)
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
			publishCallEvent(call.id, { type: 'call_status', status: 'failed' })
			publishCallEvent(call.id, { type: 'error', message: errorMessage })
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

calls.delete('/:id', async (c) => {
	const apiKey = c.get('apiKey')
	const callId = c.req.param('id')
	const db = getDb()

	const [call] = await db
		.select()
		.from(apiCalls)
		.where(and(eq(apiCalls.id, callId), eq(apiCalls.apiKeyId, apiKey.id)))
		.limit(1)

	if (!call) return c.json({ error: 'Call not found' }, 404)

	if (call.status === 'completed' || call.status === 'failed' || call.status === 'cancelled') {
		return c.json({ id: call.id, status: call.status })
	}

	await db
		.update(apiCalls)
		.set({
			status: 'cancelled',
			errorMessage: 'Call cancelled by client',
			updatedAt: new Date(),
		})
		.where(and(eq(apiCalls.id, callId), eq(apiCalls.apiKeyId, apiKey.id)))

	if (call.status === 'pending') {
		await cancelQueuedCall(callId).catch(() => {})
	}

	publishCallEvent(callId, { type: 'call_status', status: 'cancelled' })
	publishCallEvent(callId, { type: 'error', message: 'Call cancelled by client' })

	return c.json({ id: call.id, status: 'cancelled' })
})

export { calls }
