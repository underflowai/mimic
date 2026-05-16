import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createDirector } from './director.js'

function createMockClient() {
	let lastMessages: Array<{ role: string; content: string }> = []

	const client = {
		chat: {
			completions: {
				create: async (params: { messages: Array<{ role: string; content: string }> }) => {
					lastMessages = params.messages
					return {
						async *[Symbol.asyncIterator]() {
							yield { choices: [{ delta: { content: 'ok' } }] }
						},
					}
				},
			},
		},
		getLastMessages: () => lastMessages,
	}

	return client
}

describe('director buildMessages', () => {
	it('sends all turns when under maxRecentMessages (no truncation)', async () => {
		const client = createMockClient()
		const director = createDirector({
			client: client as never,
			model: 'test',
			systemPrompt: 'system',
			maxRecentMessages: 20,
		})

		for (let i = 0; i < 5; i++) {
			director.commitTurn({ kind: 'exchange', user: `user ${i}`, agent: `agent ${i}` })
		}

		await director.generateDraft('current', 'control block')
		const messages = client.getLastMessages()

		assert.equal(messages[0].role, 'system')
		assert.equal(messages[0].content, 'system')

		// system + 10 turns + control block system + user transcript
		const lastUser = messages[messages.length - 1]
		assert.equal(lastUser.role, 'user')
		assert.equal(lastUser.content, 'current')

		const controlBlockMsg = messages[messages.length - 2]
		assert.equal(controlBlockMsg.role, 'system')
		assert.equal(controlBlockMsg.content, 'control block')

		const turnMessages = messages.slice(1, -2)
		assert.equal(turnMessages.length, 10, 'all 10 turn messages should be present')
	})

	it('sends all turns when over maxRecentMessages but no summary yet', async () => {
		const client = createMockClient()
		const director = createDirector({
			client: client as never,
			model: 'test',
			systemPrompt: 'system',
			maxRecentMessages: 4,
		})

		for (let i = 0; i < 5; i++) {
			director.commitTurn({ kind: 'exchange', user: `user ${i}`, agent: `agent ${i}` })
		}

		assert.ok(director.needsSummary(), 'should need summary when over limit')

		await director.generateDraft('current', 'control block')
		const messages = client.getLastMessages()

		const turnMessages = messages.slice(1, -2)
		assert.equal(turnMessages.length, 10, 'all turns present — no truncation without summary')
		assert.ok(!messages.some((m) => m.content.includes('Earlier in this call')), 'no summary injected')
	})

	it('uses summary + recent turns once summary is set', async () => {
		const client = createMockClient()
		const director = createDirector({
			client: client as never,
			model: 'test',
			systemPrompt: 'system',
			maxRecentMessages: 4,
		})

		for (let i = 0; i < 5; i++) {
			director.commitTurn({ kind: 'exchange', user: `user ${i}`, agent: `agent ${i}` })
		}

		director.setConversationSummary('The caller discussed topics A, B, and C.', 6)

		await director.generateDraft('current', 'control block')
		const messages = client.getLastMessages()

		const summaryMessage = messages.find((m) => m.content.includes('Earlier in this call'))
		assert.ok(summaryMessage, 'summary should be injected')
		assert.ok(summaryMessage.content.includes('topics A, B, and C'))

		const turnMessages = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
		const controlBlockMsg = messages[messages.length - 1]
		const turnsOnly = turnMessages.filter((m) => m !== controlBlockMsg)
		assert.equal(turnsOnly.length, 4, 'only recent 4 turn messages (maxRecentMessages)')
	})

	it('strips [pause] and [long-pause] from agent turns in messages', async () => {
		const client = createMockClient()
		const director = createDirector({
			client: client as never,
			model: 'test',
			systemPrompt: 'system',
		})

		director.commitTurn({
			kind: 'exchange',
			user: 'hello',
			agent: 'Hi there. [pause] How are you? [long-pause] Great.',
		})

		await director.generateDraft('current', 'control block')
		const messages = client.getLastMessages()

		const agentMsg = messages.find((m) => m.role === 'assistant')
		assert.ok(agentMsg)
		assert.ok(!agentMsg.content.includes('[pause]'), 'should strip [pause]')
		assert.ok(!agentMsg.content.includes('[long-pause]'), 'should strip [long-pause]')
		assert.ok(agentMsg.content.includes('Hi there.'), 'should keep other content')
	})

	it('stores human-spoken text in agent history', () => {
		const client = createMockClient()
		const director = createDirector({
			client: client as never,
			model: 'test',
			systemPrompt: 'system',
		})

		director.commitTurn({
			kind: 'exchange',
			user: 'demo tags',
			agent:
				'[say warmly with a calm, professional tone] I can <giggle> demo this and <slow-extra>not this</slow-extra>. {"date":"next Wednesday"}',
		})

		const turns = director.listTurns()
		assert.equal(turns[1]?.role, 'agent')
		assert.equal(turns[1]?.content, 'I can demo this and not this.')
	})
})

describe('director needsSummary', () => {
	const cases = [
		{ turnCount: 3, maxRecent: 20, hasSummary: false, expected: false, desc: 'under limit' },
		{ turnCount: 12, maxRecent: 20, hasSummary: false, expected: true, desc: 'over limit, no summary' },
		{ turnCount: 12, maxRecent: 20, hasSummary: true, expected: false, desc: 'over limit, has summary' },
	]

	for (const { turnCount, maxRecent, hasSummary, expected, desc } of cases) {
		it(desc, () => {
			const client = createMockClient()
			const director = createDirector({
				client: client as never,
				model: 'test',
				systemPrompt: 'system',
				maxRecentMessages: maxRecent,
			})

			for (let i = 0; i < turnCount; i++) {
				director.commitTurn({ kind: 'exchange', user: `u${i}`, agent: `a${i}` })
			}
			if (hasSummary) director.setConversationSummary('summary', turnCount)

			assert.equal(director.needsSummary(), expected)
		})
	}
})

describe('director getOlderTurnsForSummary', () => {
	it('returns null when under limit', () => {
		const client = createMockClient()
		const director = createDirector({
			client: client as never,
			model: 'test',
			systemPrompt: 'system',
			maxRecentMessages: 20,
		})
		director.commitTurn({ kind: 'exchange', user: 'hi', agent: 'hello' })
		assert.equal(director.getOlderTurnsForSummary(), null)
	})

	it('returns older turns when over limit', () => {
		const client = createMockClient()
		const director = createDirector({
			client: client as never,
			model: 'test',
			systemPrompt: 'system',
			maxRecentMessages: 4,
		})
		for (let i = 0; i < 5; i++) {
			director.commitTurn({ kind: 'exchange', user: `u${i}`, agent: `a${i}` })
		}
		const older = director.getOlderTurnsForSummary()
		assert.ok(older)
		assert.equal(older.length, 6, 'should return turns beyond the recent window')
		assert.equal(older[0].content, 'u0')
	})
})

describe('director cancellation', () => {
	it('returns null when draft generation is aborted mid-stream', async () => {
		const abort = new AbortController()
		const client = {
			chat: {
				completions: {
					create: async () => ({
						async *[Symbol.asyncIterator]() {
							yield { choices: [{ delta: { content: 'Partial response' } }] }
							abort.abort()
							yield { choices: [{ delta: { content: ' should not commit' } }] }
						},
					}),
				},
			},
		}
		const director = createDirector({
			client: client as never,
			model: 'test',
			systemPrompt: 'system',
		})

		const result = await director.generateDraft('hello', 'control', abort.signal)
		assert.equal(result, null)
	})
})

describe('director native tool history', () => {
	it('persists tool call and result as native messages in history', async () => {
		const client = createMockClient()
		const director = createDirector({
			client: client as never,
			model: 'test',
			systemPrompt: 'system',
		})

		director.commitTurn({
			kind: 'exchange',
			user: 'who won the Lakers game',
			agent: 'Let me check that for you.',
		})

		director.commitToolCall({ id: 'call_1', name: 'webSearch', args: { query: 'lakers game result' } })
		director.commitToolResult('call_1', '{"result": "Lakers 107, Rockets 98"}')

		await director.generateDraft('next question', 'control block')

		const messages = client.getLastMessages()
		const toolMsg = messages.find((m) => m.role === 'tool')
		assert.ok(toolMsg, 'tool result message should exist in history')
		assert.ok(toolMsg.content.includes('Lakers 107, Rockets 98'))
	})

	it('tool history survives across multiple conversation turns', async () => {
		const client = createMockClient()
		const director = createDirector({
			client: client as never,
			model: 'test',
			systemPrompt: 'system',
		})

		director.commitTurn({ kind: 'exchange', user: 'what was the lakers score', agent: 'Let me check' })
		director.commitToolCall({ id: 'call_1', name: 'webSearch', args: { query: 'lakers score' } })
		director.commitToolResult('call_1', 'Lakers 107 Rockets 98')

		director.commitTurn({ kind: 'exchange', user: 'tell me about insurance', agent: 'Sure thing' })
		director.commitTurn({ kind: 'exchange', user: 'what coverage do you offer', agent: 'We offer several options' })

		await director.generateDraft('wait what was that score again', 'control block')

		const messages = client.getLastMessages()
		const lakersMessage = messages.find((m) => m.content?.includes('Lakers 107 Rockets 98'))
		assert.ok(lakersMessage, 'tool result from earlier should still be in conversation history')
	})

	it('commitToolResult appends tool result after tool call', async () => {
		const client = createMockClient()
		const director = createDirector({
			client: client as never,
			model: 'test',
			systemPrompt: 'system',
		})

		director.commitToolCall({ id: 'call_1', name: 'checkCalendar', args: { date: 'Wednesday' } })
		director.commitToolResult('call_1', '{"slots": ["10am", "11am"]}')

		await director.generateDraft('what slots', 'block')
		const messages = client.getLastMessages()
		const assistantMsg = messages.find((m) => m.role === 'assistant' && (m as { tool_calls?: unknown[] }).tool_calls)
		assert.ok(assistantMsg, 'assistant message with tool_calls should exist')
		const toolMsg = messages.find((m) => m.role === 'tool')
		assert.ok(toolMsg?.content.includes('10am'))
	})
})
