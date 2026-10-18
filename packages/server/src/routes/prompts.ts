import { Hono } from 'hono'

import { CALL_CHANNELS, type CallChannel } from '../db/schema.js'
import { compileGoal } from '../goal-compiler.js'
import { normalizeCallTools, type ApiToolInput } from '../prompt-config.js'

const prompts = new Hono()

/**
 * Compile a goal into a prompt and hand it back. Nothing is stored: the
 * caller keeps the prompt, edits it if they like, and passes it to
 * `POST /calls` as `prompt`, where it is used verbatim and never recompiled.
 */
prompts.post('/compile', async (c) => {
	let body: {
		goal: string
		context?: string
		tools?: ApiToolInput[]
		voice?: 'female' | 'male'
		aiDisclosure?: boolean
		channel?: CallChannel
	}
	try {
		body = await c.req.json<typeof body>()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

	if (!body.goal?.trim()) return c.json({ error: 'goal is required' }, 400)
	const channel: CallChannel = body.channel ?? 'phone'
	if (!CALL_CHANNELS.includes(channel)) {
		return c.json({ error: `channel must be one of: ${CALL_CHANNELS.join(', ')}` }, 400)
	}
	let tools: ReturnType<typeof normalizeCallTools>
	try {
		tools = normalizeCallTools(body.tools)
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : 'Invalid tool configuration' }, 400)
	}

	const compiled = await compileGoal({
		goal: body.goal,
		voice: body.voice ?? 'female',
		channel,
		context: body.context ?? '',
		tools,
		aiDisclosure: body.aiDisclosure,
	})

	return c.json({
		goal: body.goal,
		systemPrompt: compiled.systemPrompt,
		turnControlBlock: compiled.turnControlBlock ?? null,
		agentName: compiled.agentName,
	})
})

export { prompts }
