import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'

import { Mimic, tool } from './index.js'
import type { CallEvent, WebSocketConstructor } from './types.js'

// ---------------------------------------------------------------------------
// Mock WebSocket factory
// ---------------------------------------------------------------------------

interface MockSocket {
	url: string
	sent: string[]
	readyState: number
	open(): void
	serverSend(msg: Record<string, unknown>): void
	close(): void
}

function createMockWsFactory() {
	const sockets: MockSocket[] = []
	const Factory = function (url: string | URL) {
		const listeners: Record<string, Array<(...args: any[]) => void>> = {}
		const sent: string[] = []
		const sock: MockSocket & {
			addEventListener(t: string, fn: (...args: any[]) => void): void
			removeEventListener(): void
			send(d: string): void
		} = {
			url: String(url), sent, readyState: 0,
			addEventListener(t, fn) { ;(listeners[t] ??= []).push(fn) },
			removeEventListener() {},
			send(d) { sent.push(d) },
			close() { sock.readyState = 3; for (const fn of listeners['close'] ?? []) fn() },
			open() { sock.readyState = 1; for (const fn of listeners['open'] ?? []) fn() },
			serverSend(msg) { for (const fn of listeners['message'] ?? []) fn({ data: JSON.stringify(msg) }) },
		}
		sockets.push(sock)
		return sock
	} as unknown as WebSocketConstructor
	Object.assign(Factory, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
	return { Factory, get last(): MockSocket { return sockets[sockets.length - 1]! } }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const agentResp = { id: 'agent_1', name: 'agent', goal: 'schedule', voice: 'female', context: {}, tools: [], results: {} }
const completedCall = {
	id: 'call_1', status: 'completed',
	transcript: [{ role: 'agent', content: 'Hi!' }, { role: 'caller', content: 'Hello.' }],
	result: { confirmed: true, notes: 'all good' },
	goalAchieved: true, goalAchievedReason: 'confirmed', duration: 42, errorMessage: null,
}

function defaultFetch(): typeof fetch {
	return async (input, init) => {
		const url = String(input)
		if (url.endsWith('/api/v1/agents')) return jsonResponse(agentResp, 201)
		if (url.endsWith('/api/v1/calls') && init?.method === 'POST')
			return jsonResponse({ id: 'call_1', status: 'pending' }, 201)
		if (url.includes('/api/v1/calls/call_1')) return jsonResponse(completedCall)
		return jsonResponse({ error: 'not found' }, 404)
	}
}

function createTestMimic(fetchOverride?: typeof fetch) {
	const ws = createMockWsFactory()
	const mimic = new Mimic({ apiKey: 'mk_test', baseUrl: 'http://localhost:3000', fetch: fetchOverride ?? defaultFetch(), WebSocket: ws.Factory })
	return { mimic, ws }
}

async function waitForSocket(ws: ReturnType<typeof createMockWsFactory>) {
	await new Promise((r) => setImmediate(r))
	await new Promise((r) => setImmediate(r))
	if (ws.last) ws.last.open()
	await new Promise((r) => setImmediate(r))
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('Mimic constructor', () => {
	it('accepts a string API key', () => {
		assert.ok(new Mimic('mk_test'))
	})

	it('accepts an options object', () => {
		assert.ok(new Mimic({ apiKey: 'mk_test' }))
	})

	it('rejects empty API key', () => {
		assert.throws(() => new Mimic(''), { name: 'MimicError' })
	})

	it('rejects malformed API key', () => {
		assert.throws(() => new Mimic('bad_key'), { name: 'MimicError' })
	})
})

// ---------------------------------------------------------------------------
// call() — single options signature
// ---------------------------------------------------------------------------

describe('Mimic.call', () => {
	it('accepts options object and returns MimicCall', () => {
		const { mimic } = createTestMimic()
		const call = mimic.call({ to: '+15551234567', goal: 'Say hello' })
		assert.ok(call)
		assert.ok(call.result instanceof Promise)
	})

	it('accepts tools as tool() definitions', () => {
		const { mimic } = createTestMimic()
		const checkCalendar = tool({
			description: 'Check slots',
			parameters: z.object({ date: z.string() }),
			run: async ({ date }) => `slots for ${date}`,
		})
		const call = mimic.call({ to: '+15551234567', goal: 'Book', tools: { checkCalendar } })
		assert.ok(call)
	})
})

// ---------------------------------------------------------------------------
// Streaming events
// ---------------------------------------------------------------------------

describe('MimicCall streaming', () => {
	it('yields speech events via for-await', async () => {
		const { mimic, ws } = createTestMimic()
		const call = mimic.call({ to: '+15551234567', goal: 'Say hello' })

		await waitForSocket(ws)
		ws.last.serverSend({ type: 'speech', role: 'agent', text: 'Hello!' })
		ws.last.serverSend({ type: 'done', goalAchieved: true, goalAchievedReason: 'greeted' })

		const events: CallEvent[] = []
		for await (const event of call) events.push(event)

		assert.equal(events.length, 2)
		assert.deepEqual(events[0], { type: 'speech', role: 'agent', text: 'Hello!' })
		assert.equal(events[1]!.type, 'done')
	})
})

// ---------------------------------------------------------------------------
// .on() typed event handlers
// ---------------------------------------------------------------------------

describe('MimicCall.on()', () => {
	it('fires speech handler with narrowed type', async () => {
		const { mimic, ws } = createTestMimic()
		const call = mimic.call({ to: '+15551234567', goal: 'Say hello' })

		const speeches: Array<{ role: string; text: string }> = []
		call.on('speech', (event) => {
			speeches.push({ role: event.role, text: event.text })
		})

		await waitForSocket(ws)
		ws.last.serverSend({ type: 'speech', role: 'agent', text: 'Hi!' })
		ws.last.serverSend({ type: 'speech', role: 'caller', text: 'Hey!' })
		ws.last.serverSend({ type: 'done', goalAchieved: true, goalAchievedReason: 'done' })
		await call.result

		assert.equal(speeches.length, 2)
		assert.equal(speeches[0]!.role, 'agent')
		assert.equal(speeches[1]!.text, 'Hey!')
	})

	it('fires done handler', async () => {
		const { mimic, ws } = createTestMimic()
		const call = mimic.call({ to: '+15551234567', goal: 'Say hello' })

		let achieved: boolean | null = null
		call.on('done', (event) => { achieved = event.goalAchieved })

		await waitForSocket(ws)
		ws.last.serverSend({ type: 'done', goalAchieved: true, goalAchievedReason: 'ok' })
		await call.result

		assert.equal(achieved, true)
	})

	it('returns this for chaining', () => {
		const { mimic } = createTestMimic()
		const call = mimic.call({ to: '+15551234567', goal: 'Say hello' })
		const returned = call.on('speech', () => {}).on('done', () => {})
		assert.equal(returned, call)
	})
})

// ---------------------------------------------------------------------------
// Typed extract + discriminated result
// ---------------------------------------------------------------------------

describe('Typed extract and discriminated result', () => {
	it('.result resolves with typed data on completed', async () => {
		const { mimic, ws } = createTestMimic()
		const call = mimic.call<{ confirmed: boolean; notes: string }>({
			to: '+15551234567',
			goal: 'Confirm appointment',
			extract: z.object({
				confirmed: z.boolean().describe('whether confirmed'),
				notes: z.string().describe('any notes'),
			}),
		})

		await waitForSocket(ws)
		ws.last.serverSend({ type: 'done', goalAchieved: true, goalAchievedReason: 'confirmed' })

		const result = await call.result
		assert.equal(result.status, 'completed')
		if (result.status === 'completed') {
			assert.equal(result.goalAchieved, true)
			assert.equal(result.data.confirmed, true)
			assert.equal(result.data.notes, 'all good')
			assert.equal(result.duration, 42)
			assert.equal(result.transcript.length, 2)
		}
	})
})

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

describe('MimicCall tool dispatch', () => {
	it('executes structured tool and sends result', async () => {
		const calls: string[] = []
		const checkCalendar = tool({
			description: 'Check slots',
			parameters: z.object({ date: z.string() }),
			run: async ({ date }) => { calls.push(date); return `slots for ${date}` },
		})

		const { mimic, ws } = createTestMimic()
		const call = mimic.call({ to: '+15551234567', goal: 'Book', tools: { checkCalendar } })

		await waitForSocket(ws)
		ws.last.serverSend({ type: 'tool_call', callbackId: 'cb_1', toolName: 'checkCalendar', toolArgs: { date: 'Thursday' } })
		await new Promise((r) => setImmediate(r))
		await new Promise((r) => setImmediate(r))

		assert.equal(calls.length, 1)
		assert.equal(calls[0], 'Thursday')

		const sent = JSON.parse(ws.last.sent[ws.last.sent.length - 1]!)
		assert.equal(sent.type, 'tool_result')
		assert.equal(sent.result, 'slots for Thursday')

		ws.last.serverSend({ type: 'done', goalAchieved: true, goalAchievedReason: 'booked' })
		await call.result
	})

	it('sends tool_error with instructive Zod validation message', async () => {
		const book = tool({
			description: 'Book meeting',
			parameters: z.object({ date: z.string(), email: z.string().email() }),
			run: async () => 'ok',
		})

		const { mimic, ws } = createTestMimic()
		const call = mimic.call({ to: '+15551234567', goal: 'Book', tools: { book } })

		await waitForSocket(ws)
		ws.last.serverSend({ type: 'tool_call', callbackId: 'cb_1', toolName: 'book', toolArgs: { date: 123, email: 'bad' } })
		await new Promise((r) => setImmediate(r))
		await new Promise((r) => setImmediate(r))

		const sent = JSON.parse(ws.last.sent[ws.last.sent.length - 1]!)
		assert.equal(sent.type, 'tool_error')
		assert.ok(sent.error.includes('Tool "book" received invalid arguments'))
		assert.ok(sent.error.includes('date'))

		ws.last.serverSend({ type: 'done', goalAchieved: false, goalAchievedReason: 'failed' })
		await call.result
	})
})

// ---------------------------------------------------------------------------
// Error suggestions
// ---------------------------------------------------------------------------

describe('Error suggestions', () => {
	it('suggests similar tool name on typo', async () => {
		const checkCalendar = tool({
			description: 'Check slots',
			parameters: z.object({ date: z.string() }),
			run: async () => 'ok',
		})

		const { mimic, ws } = createTestMimic()
		const call = mimic.call({ to: '+15551234567', goal: 'Book', tools: { checkCalendar } })

		await waitForSocket(ws)
		ws.last.serverSend({ type: 'tool_call', callbackId: 'cb_1', toolName: 'checkCalendr', toolArgs: {} })
		await new Promise((r) => setImmediate(r))
		await new Promise((r) => setImmediate(r))

		const sent = JSON.parse(ws.last.sent[ws.last.sent.length - 1]!)
		assert.equal(sent.type, 'tool_error')
		assert.ok(sent.error.includes('Did you mean "checkCalendar"'), `got: ${sent.error}`)
		assert.ok(sent.error.includes('Available tools: checkCalendar'), `got: ${sent.error}`)

		ws.last.serverSend({ type: 'done', goalAchieved: false, goalAchievedReason: 'err' })
		await call.result
	})
})

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

describe('MimicCall.cancel', () => {
	it('rejects .result and emits error event', async () => {
		const { mimic, ws } = createTestMimic()
		const call = mimic.call({ to: '+15551234567', goal: 'Say hello' })

		await waitForSocket(ws)
		call.cancel()

		await assert.rejects(call.result, { name: 'MimicError', message: 'Call cancelled' })
	})
})

// ---------------------------------------------------------------------------
// Polling fallback
// ---------------------------------------------------------------------------

describe('MimicCall polling fallback', () => {
	it('polls to completion when WebSocket is disabled', async () => {
		let pollCount = 0
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input)
			if (url.endsWith('/api/v1/agents')) return jsonResponse(agentResp, 201)
			if (url.endsWith('/api/v1/calls') && init?.method === 'POST')
				return jsonResponse({ id: 'call_1', status: 'pending' }, 201)
			if (url.includes('/api/v1/calls/call_1')) {
				pollCount++
				if (pollCount >= 2) return jsonResponse(completedCall)
				return jsonResponse({ ...completedCall, status: 'in_progress', goalAchieved: null, result: null, transcript: null })
			}
			return jsonResponse({ error: 'not found' }, 404)
		}

		const mimic = new Mimic({ apiKey: 'mk_test', baseUrl: 'http://localhost:3000', fetch: fetchImpl, WebSocket: null })
		const call = mimic.call({ to: '+15551234567', goal: 'Say hello' })
		const result = await call.result
		assert.equal(result.status, 'completed')
		if (result.status === 'completed') {
			assert.equal(result.goalAchieved, true)
		}
	})
})
