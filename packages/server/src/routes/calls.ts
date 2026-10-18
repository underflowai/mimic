import { Hono } from 'hono'
import { and, desc, eq, or, sql } from 'drizzle-orm'
import { RoomServiceClient } from 'livekit-server-sdk'

import { config } from '@mimic/engine'

import { publishCallEvent } from '../call-bus.js'
import { notifyCallWebhook, toCallRecord } from '../call-record.js'
import { inferCallerTimezone } from '../caller-timezone.js'
import { getDb } from '../db/index.js'
import { apiAgents, apiCalls, CALL_CHANNELS, type ApiCallRow, type CallChannel } from '../db/schema.js'
import { compileGoal } from '../goal-compiler.js'
import { hashPromptConfig, normalizeCallTools, type ApiToolInput } from '../prompt-config.js'
import { cancelQueuedCall, enqueueCall } from '../jobs/queue.js'
import { childLogger } from '../logger.js'
import { MAX_CONCURRENT_CALLS } from '../middleware/rate-limit.js'
import { isUuid } from '../uuid.js'
import { createWebJoin } from '../web-join.js'

const calls = new Hono()

/**
 * The body of a 201 (or an idempotent replay). Web calls that can still be
 * joined carry the browser's credentials; the caller's server hands those to
 * its page. Replays re-mint so a retried create is still usable.
 */
async function createdBody(call: Pick<ApiCallRow, 'id' | 'status' | 'channel'>, participantName?: string) {
	const joinable = call.status === 'pending' || call.status === 'in_progress'
	if (call.channel !== 'web' || !joinable) return { id: call.id, status: call.status }
	const web = await createWebJoin({
		callId: call.id,
		name: participantName,
		livekit: { url: config.livekit.url, apiKey: config.livekit.apiKey, apiSecret: config.livekit.apiSecret },
	})
	return { id: call.id, status: call.status, web }
}

calls.post('/', async (c) => {
	const apiKey = c.get('apiKey')
	let body: {
		/**
		 * `phone` (default) dials `to` over SIP. `web` skips dialing and returns
		 * a LiveKit join token so a browser can connect to the call's room.
		 */
		channel?: CallChannel
		/** E.164 phone number. Required for phone calls; ignored for web calls. */
		to?: string
		/** What the agent is trying to do. Compiled into a prompt once and cached. Pass this or `prompt`. */
		goal?: string
		/**
		 * A prompt the caller owns, from `POST /prompts/compile` or hand-written.
		 * Used verbatim, never recompiled. Its `goal` is the extractor's rubric.
		 */
		prompt?: { goal: string; systemPrompt: string; turnControlBlock?: string | null; agentName?: string }
		voice?: 'female' | 'male'
		userTimezone?: string
		context?: string
		data?: Record<string, unknown>
		recipient?: { firstName: string; lastName?: string; email?: string }
		aiDisclosure?: boolean
		tools?: ApiToolInput[]
		/** What the caller wants back. Shown to the agent at runtime and read by the extractor afterward. */
		extract?: Record<string, unknown>
		ambience?: boolean
		idempotencyKey?: string
		/** POSTed `{ event: 'call.completed' | 'call.failed', call }` when this call ends. */
		webhook?: string
		/** Signs each delivery (`x-mimic-signature: t=<unix seconds>,v1=<hmac-sha256 hex>` over `<t>.<body>`). */
		webhookSecret?: string
	}
	try {
		body = await c.req.json<typeof body>()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

	const channel: CallChannel = body.channel ?? 'phone'
	if (!CALL_CHANNELS.includes(channel)) {
		return c.json({ error: `channel must be one of: ${CALL_CHANNELS.join(', ')}` }, 400)
	}
	const toPhone = channel === 'phone' ? (body.to?.trim() ?? '') : null
	if (channel === 'phone' && !toPhone) return c.json({ error: 'to (phone number) is required' }, 400)

	let tools: ReturnType<typeof normalizeCallTools>
	try {
		tools = normalizeCallTools(body.tools)
		if (body.userTimezone !== undefined) {
			if (!body.userTimezone.trim()) throw new Error('userTimezone must be an IANA timezone')
			new Intl.DateTimeFormat('en-US', { timeZone: body.userTimezone }).format()
		}
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : 'Invalid tool or timezone configuration' }, 400)
	}

	// The agent is defined by a goal to compile or by a prompt the caller owns.
	const goal = (body.prompt ? body.prompt.goal : body.goal)?.trim() ?? ''
	if (!goal) return c.json({ error: body.prompt ? 'prompt.goal is required' : 'goal is required' }, 400)

	const ownedPrompt = body.prompt
		? {
				systemPrompt: body.prompt.systemPrompt?.trim() ?? '',
				turnControlBlock: body.prompt.turnControlBlock?.trim() || undefined,
				agentName: body.prompt.agentName?.trim() || undefined,
			}
		: null
	if (ownedPrompt && !ownedPrompt.systemPrompt) {
		return c.json({ error: 'prompt.systemPrompt must not be empty' }, 400)
	}
	if (ownedPrompt && ownedPrompt.systemPrompt.length > 48_000) {
		return c.json({ error: 'prompt.systemPrompt exceeds 48000 characters' }, 400)
	}
	if (body.webhook && !/^https?:\/\//.test(body.webhook)) {
		return c.json({ error: 'webhook must be an http(s) URL' }, 400)
	}
	if (body.webhookSecret && !body.webhook) {
		return c.json({ error: 'webhookSecret requires webhook' }, 400)
	}

	const db = getDb()

	if (body.idempotencyKey) {
		const [existing] = await db
			.select()
			.from(apiCalls)
			.where(and(eq(apiCalls.apiKeyId, apiKey.id), eq(apiCalls.idempotencyKey, body.idempotencyKey)))
			.limit(1)
		if (existing) return c.json(await createdBody(existing, body.recipient?.firstName))
	}

	const voice = body.voice ?? 'female'
	const defaultAgentName = voice === 'male' ? 'Arlo' : 'Aurora'
	const results = body.extract ?? {}
	// Office ambience is for the phone; a browser session defaults to a clean mix.
	const ambience = channel === 'web' ? (body.ambience ?? false) : body.ambience

	const configHash = hashPromptConfig(apiKey.id, {
		goal,
		voice,
		channel,
		context: body.context,
		tools,
		aiDisclosure: body.aiDisclosure,
		ambience,
		...(ownedPrompt && { prompt: ownedPrompt }),
	})

	// The compiled prompt is cached per config hash; every call with the same
	// goal, tools, and data shape reuses one agent row.
	const [cached] = await db
		.select()
		.from(apiAgents)
		.where(
			and(
				eq(apiAgents.apiKeyId, apiKey.id),
				eq(apiAgents.configHash, configHash),
				sql`${apiAgents.systemPrompt} <> ''`,
			),
		)
		.limit(1)

	let agentId: string
	let needsCompilation = false

	if (cached) {
		agentId = cached.id
	} else if (ownedPrompt) {
		// The caller owns the prompt. Store it as-is, ready to dial.
		const [inserted] = await db
			.insert(apiAgents)
			.values({
				apiKeyId: apiKey.id,
				name: goal.slice(0, 80),
				goal,
				voice,
				context: body.context ?? '',
				tools,
				configHash,
				systemPrompt: ownedPrompt.systemPrompt,
				turnControlBlock: ownedPrompt.turnControlBlock ?? null,
				agentName: ownedPrompt.agentName ?? defaultAgentName,
				ambience: ambience ?? true,
			})
			.returning()
		agentId = inserted.id
	} else {
		// Create a placeholder agent row — compile in background
		const [placeholder] = await db
			.insert(apiAgents)
			.values({
				apiKeyId: apiKey.id,
				name: goal.slice(0, 80),
				goal,
				voice,
				context: body.context ?? '',
				tools,
				configHash,
				systemPrompt: '',
				agentName: defaultAgentName,
				ambience: ambience ?? true,
			})
			.returning()
		agentId = placeholder.id
		needsCompilation = true
	}

	const callContext: Record<string, string> = {}
	if (body.userTimezone) {
		callContext.userTimezone = body.userTimezone
	} else if (toPhone) {
		// No zone supplied: guess from the area code. The engine labels the guess
		// unconfirmed and the agent checks it with the caller before relying on it.
		// A web call has no number to guess from; the agent asks if it matters.
		const guess = inferCallerTimezone(toPhone)
		if (guess) {
			callContext.userTimezone = guess
			callContext.userTimezoneInferred = 'true'
		}
	}
	if (body.recipient?.firstName) callContext.firstName = body.recipient.firstName
	if (body.recipient?.lastName) callContext.lastName = body.recipient.lastName
	if (body.recipient?.email) callContext.email = body.recipient.email

	// The compiled agent is shared by every call with the same data *shape*;
	// the values belong to this call and are injected into its prompt at runtime.
	const callData = body.data && Object.keys(body.data).length > 0 ? body.data : null
	const webhookUrl = body.webhook ?? null
	const webhookSecret = body.webhook ? (body.webhookSecret ?? null) : null

	const [concurrencyRow] = await db
		.select({ activeCalls: sql<number>`count(*)::int` })
		.from(apiCalls)
		.where(
			and(eq(apiCalls.apiKeyId, apiKey.id), or(eq(apiCalls.status, 'pending'), eq(apiCalls.status, 'in_progress'))),
		)

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
				channel,
				toPhone,
				callContext,
				callData,
				results,
				webhookUrl,
				webhookSecret,
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
			return c.json(await createdBody(existing, body.recipient?.firstName), 200)
		}
	} else {
		const [inserted] = await db
			.insert(apiCalls)
			.values({
				apiKeyId: apiKey.id,
				agentId,
				channel,
				toPhone,
				callContext,
				callData,
				results,
				webhookUrl,
				webhookSecret,
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
					goal,
					voice,
					channel,
					context: body.context ?? '',
					tools,
					aiDisclosure: body.aiDisclosure,
				})

				await db
					.update(apiAgents)
					.set({
						systemPrompt: compiled.systemPrompt,
						turnControlBlock: compiled.turnControlBlock ?? null,
						agentName: compiled.agentName,
					})
					.where(eq(apiAgents.id, agentId))
			}

			await enqueueCall({ callId: call.id, agentId })
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err)
			await db
				.update(apiCalls)
				.set({ status: 'failed', errorMessage })
				.where(eq(apiCalls.id, call.id))
				.catch(() => {})
			publishCallEvent(call.id, { type: 'call_status', status: 'failed' })
			publishCallEvent(call.id, { type: 'error', message: errorMessage })
		}
	})()

	return c.json(await createdBody(call, body.recipient?.firstName), 201)
})

const CALL_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'] as const
const LIST_DEFAULT_LIMIT = 20
const LIST_MAX_LIMIT = 100

/** Keyset cursor: the last row's position in (created_at desc, id desc). */
function encodeCursor(row: Pick<ApiCallRow, 'createdAt' | 'id'>) {
	return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url')
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
	const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|')
	if (!iso || !id || !isUuid(id)) return null
	const createdAt = new Date(iso)
	return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id }
}

/** Newest first. `?limit=` (1–100, default 20), `?status=`, `?cursor=` from the previous page's `nextCursor`. */
calls.get('/', async (c) => {
	const apiKey = c.get('apiKey')
	const query = c.req.query()

	const limit = query.limit === undefined ? LIST_DEFAULT_LIMIT : Number(query.limit)
	if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
		return c.json({ error: `limit must be an integer between 1 and ${LIST_MAX_LIMIT}` }, 400)
	}
	const status = query.status as (typeof CALL_STATUSES)[number] | undefined
	if (status !== undefined && !CALL_STATUSES.includes(status)) {
		return c.json({ error: `status must be one of: ${CALL_STATUSES.join(', ')}` }, 400)
	}
	const cursor = query.cursor ? decodeCursor(query.cursor) : null
	if (query.cursor && !cursor) return c.json({ error: 'cursor is invalid' }, 400)

	const rows = await getDb()
		.select()
		.from(apiCalls)
		.where(
			and(
				eq(apiCalls.apiKeyId, apiKey.id),
				status && eq(apiCalls.status, status),
				cursor ? sql`(${apiCalls.createdAt}, ${apiCalls.id}) < (${cursor.createdAt}, ${cursor.id}::uuid)` : undefined,
			),
		)
		.orderBy(desc(apiCalls.createdAt), desc(apiCalls.id))
		.limit(limit + 1)

	const page = rows.slice(0, limit)
	const last = page.at(-1)
	return c.json({
		calls: await Promise.all(page.map(toCallRecord)),
		nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
	})
})

calls.get('/:id', async (c) => {
	const apiKey = c.get('apiKey')
	const callId = c.req.param('id')
	if (!isUuid(callId)) return c.json({ error: 'Call not found' }, 404)
	const db = getDb()

	const [call] = await db
		.select()
		.from(apiCalls)
		.where(and(eq(apiCalls.id, callId), eq(apiCalls.apiKeyId, apiKey.id)))
		.limit(1)

	if (!call) return c.json({ error: 'Call not found' }, 404)

	return c.json(await toCallRecord(call))
})

calls.delete('/:id', async (c) => {
	const apiKey = c.get('apiKey')
	const callId = c.req.param('id')
	if (!isUuid(callId)) return c.json({ error: 'Call not found' }, 404)
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

	if (call.status === 'in_progress') {
		// Deleting the room ends the SIP leg and the agent session; the worker
		// sees the cancelled status and skips the completion write.
		try {
			const roomService = new RoomServiceClient(config.livekit.url, config.livekit.apiKey, config.livekit.apiSecret)
			await roomService.deleteRoom(`mimic-call-${callId}`)
		} catch (err) {
			// Room may already be gone (call ended between status read and here).
			childLogger({ callId, err: err instanceof Error ? err.message : String(err) }).warn(
				'failed to delete LiveKit room during cancel',
			)
		}
	}

	publishCallEvent(callId, { type: 'call_status', status: 'cancelled' })
	publishCallEvent(callId, { type: 'error', message: 'Call cancelled by client' })
	// The worker skips its own writes once it sees the cancel, so the webhook is ours to send.
	void notifyCallWebhook(callId)

	return c.json({ id: call.id, status: 'cancelled' })
})

export { calls }
