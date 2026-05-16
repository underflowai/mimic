import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ApiError } from './errors.js'
import { Mimic } from './index.js'

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const agentResponse = {
	id: 'agent_1',
	name: 'agent',
	goal: 'schedule',
	voice: 'female',
	context: {},
	tools: [],
	results: {},
}

const completedCallResponse = {
	id: 'call_1',
	status: 'completed',
	transcript: [{ role: 'assistant', content: 'Booked.' }],
	result: { scheduled: true },
	goalAchieved: true,
	goalAchievedReason: 'meeting booked',
	duration: 42,
	errorMessage: null,
}

describe('Mimic.call', () => {
	it('creates an agent, starts a call, polls until completed, and returns normalized result', async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = []
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input)
			requests.push({ url, init })
			if (url.endsWith('/api/v1/agents')) return jsonResponse(agentResponse, 201)
			if (url.endsWith('/api/v1/calls') && init?.method === 'POST')
				return jsonResponse({ id: 'call_1', status: 'pending' }, 201)
			if (url.endsWith('/api/v1/calls/call_1')) return jsonResponse(completedCallResponse)
			return jsonResponse({ error: 'not found' }, 404)
		}
		const mimic = new Mimic({ apiKey: 'sk_test', baseUrl: 'http://localhost:3000', fetch: fetchImpl })

		const result = await mimic.call({
			to: '+14155551212',
			goal: 'Schedule a demo',
			results: { scheduled: 'Whether a meeting was scheduled' },
			pollIntervalMs: 1,
		})

		assert.equal(result.id, 'call_1')
		assert.equal(result.goalAchieved, true)
		assert.deepEqual(result.data, { scheduled: true })
		assert.equal(
			requests[0]?.init?.headers && (requests[0].init.headers as Record<string, string>).authorization,
			'Bearer sk_test',
		)
	})

	it('returns typed data with generic parameter', async () => {
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input)
			if (url.endsWith('/api/v1/agents')) return jsonResponse(agentResponse, 201)
			if (url.endsWith('/api/v1/calls') && init?.method === 'POST')
				return jsonResponse({ id: 'call_1', status: 'pending' }, 201)
			return jsonResponse(completedCallResponse)
		}
		const mimic = new Mimic({ apiKey: 'sk_test', baseUrl: 'http://localhost:3000', fetch: fetchImpl })

		const result = await mimic.call<{ scheduled: boolean }>({
			to: '+14155551212',
			goal: 'Schedule a demo',
			results: { scheduled: 'boolean' },
			pollIntervalMs: 1,
		})

		const scheduled: boolean = result.data.scheduled
		assert.equal(scheduled, true)
	})

	it('supports reusable agents', async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input)
			if (url.endsWith('/api/v1/agents')) return jsonResponse({ ...agentResponse, id: 'agent_2' }, 201)
			if (url.endsWith('/api/v1/calls')) return jsonResponse({ id: 'call_2', status: 'pending' }, 201)
			return jsonResponse({
				...completedCallResponse,
				id: 'call_2',
				goalAchieved: false,
				goalAchievedReason: '',
				result: {},
				duration: null,
			})
		}
		const mimic = new Mimic({ apiKey: 'sk_test', baseUrl: 'http://localhost:3000', fetch: fetchImpl })
		const agent = await mimic.createAgent({ goal: 'Schedule a demo' })
		const result = await agent.call('+14155551212', { pollIntervalMs: 1 })
		assert.equal(result.id, 'call_2')
	})
})

describe('Mimic.getAgent', () => {
	it('fetches an agent by id', async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input)
			if (url.endsWith('/api/v1/agents/agent_1')) return jsonResponse(agentResponse)
			return jsonResponse({ error: 'not found' }, 404)
		}
		const mimic = new Mimic({ apiKey: 'sk_test', baseUrl: 'http://localhost:3000', fetch: fetchImpl })
		const agent = await mimic.getAgent('agent_1')
		assert.equal(agent.agent.id, 'agent_1')
	})
})

describe('Mimic.updateAgent', () => {
	it('patches an agent and returns updated version', async () => {
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input)
			if (url.endsWith('/api/v1/agents/agent_1') && init?.method === 'PATCH') {
				const body = JSON.parse(init.body as string)
				return jsonResponse({ ...agentResponse, name: body.name })
			}
			return jsonResponse({ error: 'not found' }, 404)
		}
		const mimic = new Mimic({ apiKey: 'sk_test', baseUrl: 'http://localhost:3000', fetch: fetchImpl })
		const agent = await mimic.updateAgent('agent_1', { name: 'Updated Agent' })
		assert.equal(agent.agent.name, 'Updated Agent')
	})
})

describe('Mimic.getCall', () => {
	it('fetches a call by id and returns CallResult', async () => {
		const fetchImpl: typeof fetch = async () => jsonResponse(completedCallResponse)
		const mimic = new Mimic({ apiKey: 'sk_test', baseUrl: 'http://localhost:3000', fetch: fetchImpl })
		const result = await mimic.getCall('call_1')
		assert.equal(result.id, 'call_1')
		assert.equal(result.goalAchieved, true)
		assert.deepEqual(result.data, { scheduled: true })
	})
})

describe('ApiError structured codes', () => {
	it('derives error code from HTTP status', async () => {
		const fetchImpl: typeof fetch = async () => jsonResponse({ error: 'Bad input' }, 400)
		const mimic = new Mimic({ apiKey: 'sk_test', baseUrl: 'http://localhost:3000', fetch: fetchImpl })
		try {
			await mimic.getCall('bad')
			assert.fail('should have thrown')
		} catch (err) {
			assert.ok(err instanceof ApiError)
			assert.equal(err.code, 'invalid_request')
			assert.equal(err.status, 400)
			assert.equal(err.requestId, null)
		}
	})

	it('extracts code and requestId from response body when present', async () => {
		const fetchImpl: typeof fetch = async () =>
			jsonResponse({ error: 'Agent not found', code: 'agent_not_found', requestId: 'req_abc123' }, 404)
		const mimic = new Mimic({ apiKey: 'sk_test', baseUrl: 'http://localhost:3000', fetch: fetchImpl })
		try {
			await mimic.getAgent('missing')
			assert.fail('should have thrown')
		} catch (err) {
			assert.ok(err instanceof ApiError)
			assert.equal(err.code, 'agent_not_found')
			assert.equal(err.requestId, 'req_abc123')
			assert.equal(err.status, 404)
		}
	})

	it('derives authentication_failed for 401', async () => {
		const fetchImpl: typeof fetch = async () => jsonResponse({ error: 'Invalid API key' }, 401)
		const mimic = new Mimic({ apiKey: 'bad', baseUrl: 'http://localhost:3000', fetch: fetchImpl })
		try {
			await mimic.getCall('x')
			assert.fail('should have thrown')
		} catch (err) {
			assert.ok(err instanceof ApiError)
			assert.equal(err.code, 'authentication_failed')
		}
	})
})
