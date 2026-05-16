import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Mimic } from './index.js'
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
			url: String(url),
			sent,
			readyState: 0,
			addEventListener(t, fn) {
				;(listeners[t] ??= []).push(fn)
			},
			removeEventListener() {},
			send(d) {
				sent.push(d)
			},
			close() {
				sock.readyState = 3
				for (const fn of listeners['close'] ?? []) fn()
			},
			open() {
				sock.readyState = 1
				for (const fn of listeners['open'] ?? []) fn()
			},
			serverSend(msg) {
				for (const fn of listeners['message'] ?? []) fn({ data: JSON.stringify(msg) })
			},
		}
		sockets.push(sock)
		return sock
	} as unknown as WebSocketConstructor

	Object.assign(Factory, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
	return {
		Factory,
		get last(): MockSocket {
			return sockets[sockets.length - 1]!
		},
	}
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const agentResp = { id: 'agent_1', name: 'agent', goal: 'schedule', voice: 'female', context: {}, tools: [], results: {} }

const completedCall = {
	id: 'call_1',
	status: 'completed',
	transcript: [
		{ role: 'agent', content: 'Hi, calling about your appointment.' },
		{ role: 'caller', content: 'Yes, Thursday works.' },
	],
	result: { confirmed: true },
	goalAchieved: true,
	goalAchievedReason: 'appointment confirmed',
	duration: 42,
	errorMessage: null,
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
	const mimic = new Mimic({
		apiKey: 'mk_test',
		baseUrl: 'http://localhost:3000',
		fetch: fetchOverride ?? defaultFetch(),
		WebSocket: ws.Factory,
	})
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
		const mimic = new Mimic('mk_test')
		assert.ok(mimic)
	})

	it('accepts an options object', () => {
		const mimic = new Mimic({ apiKey: 'mk_test', baseUrl: 'http://localhost:3000' })
		assert.ok(mimic)
	})
})

// ---------------------------------------------------------------------------
// Call overloads
// ---------------------------------------------------------------------------

describe('Mimic.call overloads', () => {
	it('positional: (to, goal, tools)', () => {
		const { mimic } = createTestMimic()
		function checkCalendar(date: string) {
			return `slots for ${date}`
		}
		const call = mimic.call('+15551234567', 'Book appointment', { checkCalendar })
		assert.ok(call)
		assert.ok(call.result instanceof Promise)
	})

	it('options object with all fields', () => {
		const { mimic } = createTestMimic()
		const call = mimic.call({
			to: '+15551234567',
			goal: 'Book appointment',
			voice: 'male',
			context: { patientName: 'Jane' },
			extract: { confirmed: 'whether confirmed' },
		})
		assert.ok(call)
	})

	it('positional without tools: (to, goal)', () => {
		const { mimic } = createTestMimic()
		const call = mimic.call('+15551234567', 'Say hello')
		assert.ok(call)
	})
})

// ---------------------------------------------------------------------------
// Streaming events
// ---------------------------------------------------------------------------

describe('MimicCall streaming', () => {
	it('yields speech events and done', async () => {
		const { mimic, ws } = createTestMimic()
		const call = mimic.call('+15551234567', 'Say hello')

		await waitForSocket(ws)

		ws.last.serverSend({ type: 'speech', role: 'agent', text: 'Hello there!' })
		ws.last.serverSend({ type: 'speech', role: 'caller', text: 'Hi!' })
		ws.last.serverSend({ type: 'done', goalAchieved: true, goalAchievedReason: 'greeted' })

		const events: CallEvent[] = []
		for await (const event of call) {
			events.push(event)
		}

		assert.equal(events.length, 3)
		assert.deepEqual(events[0], { type: 'speech', role: 'agent', text: 'Hello there!' })
		assert.deepEqual(events[1], { type: 'speech', role: 'caller', text: 'Hi!' })
		assert.equal(events[2]!.type, 'done')
		if (events[2]!.type === 'done') {
			assert.equal(events[2]!.goalAchieved, true)
		}
	})

	it('.result resolves with full call data', async () => {
		const { mimic, ws } = createTestMimic()
		const call = mimic.call('+15551234567', 'Confirm appointment')

		await waitForSocket(ws)
		ws.last.serverSend({ type: 'done', goalAchieved: true, goalAchievedReason: 'confirmed' })

		const result = await call.result
		assert.equal(result.id, 'call_1')
		assert.equal(result.goalAchieved, true)
		assert.deepEqual(result.data, { confirmed: true })
		assert.equal(result.transcript.length, 2)
		assert.equal(result.duration, 42)
	})
})

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

describe('MimicCall tool dispatch', () => {
	it('executes local tool and sends result to server', async () => {
		const calls: string[] = []
		async function checkCalendar(date: string) {
			calls.push(date)
			return `Slots for ${date}: 2pm, 3pm`
		}

		const { mimic, ws } = createTestMimic()
		const call = mimic.call('+15551234567', 'Book appointment', { checkCalendar })

		await waitForSocket(ws)

		ws.last.serverSend({
			type: 'tool_call',
			callbackId: 'cb_1',
			toolName: 'checkCalendar',
			toolArgs: { date: 'Thursday' },
		})

		await new Promise((r) => setImmediate(r))
		await new Promise((r) => setImmediate(r))

		assert.equal(calls.length, 1)
		assert.equal(calls[0], 'Thursday')

		const sent = JSON.parse(ws.last.sent[ws.last.sent.length - 1]!)
		assert.equal(sent.type, 'tool_result')
		assert.equal(sent.callbackId, 'cb_1')
		assert.equal(sent.result, 'Slots for Thursday: 2pm, 3pm')

		ws.last.serverSend({ type: 'done', goalAchieved: true, goalAchievedReason: 'booked' })
		await call.result
	})

	it('sends tool_error when tool throws', async () => {
		function failingTool() {
			throw new Error('database down')
		}

		const { mimic, ws } = createTestMimic()
		const call = mimic.call('+15551234567', 'Do something', { failingTool })

		await waitForSocket(ws)

		ws.last.serverSend({
			type: 'tool_call',
			callbackId: 'cb_2',
			toolName: 'failingTool',
			toolArgs: {},
		})

		await new Promise((r) => setImmediate(r))
		await new Promise((r) => setImmediate(r))

		const sent = JSON.parse(ws.last.sent[ws.last.sent.length - 1]!)
		assert.equal(sent.type, 'tool_error')
		assert.equal(sent.callbackId, 'cb_2')
		assert.equal(sent.error, 'database down')

		ws.last.serverSend({ type: 'done', goalAchieved: false, goalAchievedReason: 'failed' })
		await call.result
	})

	it('emits tool_call and tool_result events in the stream', async () => {
		function checkCalendar(date: string) {
			return `open: ${date}`
		}

		const { mimic, ws } = createTestMimic()
		const call = mimic.call('+15551234567', 'Book appointment', { checkCalendar })

		await waitForSocket(ws)

		ws.last.serverSend({
			type: 'tool_call',
			callbackId: 'cb_3',
			toolName: 'checkCalendar',
			toolArgs: { date: 'Friday' },
		})

		await new Promise((r) => setImmediate(r))
		await new Promise((r) => setImmediate(r))

		ws.last.serverSend({ type: 'done', goalAchieved: true, goalAchievedReason: 'done' })

		const events: CallEvent[] = []
		for await (const event of call) {
			events.push(event)
		}

		const toolCall = events.find((e) => e.type === 'tool_call')
		assert.ok(toolCall)
		if (toolCall?.type === 'tool_call') {
			assert.equal(toolCall.name, 'checkCalendar')
			assert.deepEqual(toolCall.args, { date: 'Friday' })
		}

		const toolResult = events.find((e) => e.type === 'tool_result')
		assert.ok(toolResult)
		if (toolResult?.type === 'tool_result') {
			assert.equal(toolResult.name, 'checkCalendar')
			assert.equal(toolResult.result, 'open: Friday')
		}
	})
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('MimicCall error handling', () => {
	it('rejects .result on API auth error', async () => {
		const ws = createMockWsFactory()
		const mimic = new Mimic({
			apiKey: 'mk_bad',
			baseUrl: 'http://localhost:3000',
			fetch: async () => jsonResponse({ error: 'Invalid API key' }, 401),
			WebSocket: ws.Factory,
		})

		const call = mimic.call('+15551234567', 'Say hello')
		await assert.rejects(call.result, { name: 'ApiError' })
	})

	it('emits error events from server', async () => {
		const { mimic, ws } = createTestMimic()
		const call = mimic.call('+15551234567', 'Say hello')

		await waitForSocket(ws)

		ws.last.serverSend({ type: 'error', message: 'Internal server error' })
		ws.last.serverSend({ type: 'done', goalAchieved: false, goalAchievedReason: 'error' })

		const events: CallEvent[] = []
		for await (const event of call) {
			events.push(event)
		}

		assert.ok(events.some((e) => e.type === 'error' && e.message === 'Internal server error'))
	})

	it('rejects on call_status failed', async () => {
		const { mimic, ws } = createTestMimic()
		const call = mimic.call('+15551234567', 'Say hello')

		await waitForSocket(ws)
		ws.last.serverSend({ type: 'call_status', status: 'failed' })

		await assert.rejects(call.result, { name: 'CallFailedError' })
	})
})

// ---------------------------------------------------------------------------
// Polling fallback
// ---------------------------------------------------------------------------

describe('MimicCall.cancel', () => {
	it('cancels a streaming call and rejects .result', async () => {
		const { mimic, ws } = createTestMimic()
		const call = mimic.call('+15551234567', 'Say hello')

		await waitForSocket(ws)

		ws.last.serverSend({ type: 'speech', role: 'agent', text: 'Hi!' })
		call.cancel()

		await assert.rejects(call.result, { name: 'MimicError', message: 'Call cancelled' })
	})

	it('cancel is idempotent', async () => {
		const { mimic, ws } = createTestMimic()
		const call = mimic.call('+15551234567', 'Say hello')

		await waitForSocket(ws)

		call.cancel()
		call.cancel()

		await assert.rejects(call.result, { name: 'MimicError' })
	})
})

describe('Mimic constructor validation', () => {
	it('rejects empty API key', () => {
		assert.throws(() => new Mimic(''), { name: 'MimicError' })
	})

	it('rejects malformed API key', () => {
		assert.throws(() => new Mimic('bad_key'), { name: 'MimicError' })
	})

	it('accepts mk_ prefixed keys', () => {
		const mimic = new Mimic({ apiKey: 'mk_test', baseUrl: 'http://localhost' })
		assert.ok(mimic)
	})

	it('accepts sk_ prefixed keys for backwards compat', () => {
		const mimic = new Mimic({ apiKey: 'sk_test', baseUrl: 'http://localhost' })
		assert.ok(mimic)
	})
})

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
				return jsonResponse({
					...completedCall,
					status: 'in_progress',
					goalAchieved: null,
					result: null,
					transcript: null,
				})
			}
			return jsonResponse({ error: 'not found' }, 404)
		}

		const mimic = new Mimic({
			apiKey: 'mk_test',
			baseUrl: 'http://localhost:3000',
			fetch: fetchImpl,
			WebSocket: null,
		})

		const call = mimic.call('+15551234567', 'Say hello')
		const result = await call.result
		assert.equal(result.id, 'call_1')
		assert.equal(result.goalAchieved, true)
		assert.ok(pollCount >= 2)
	})
})
