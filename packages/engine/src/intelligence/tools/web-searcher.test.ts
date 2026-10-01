import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import OpenAI from 'openai'

import { createWebSearcher } from './web-searcher.js'

describe('web-searcher', () => {
	it('createWebSearcher exposes search method', async () => {
		const { createWebSearcher } = await import('./web-searcher.js')
		const client = new OpenAI({ apiKey: 'test-key' })
		const searcher = createWebSearcher(client, { agentName: 'Aurora' })
		assert.equal(typeof searcher.search, 'function')
	})

	it('retries when structured output is truncated at token cap', async () => {
		const { createWebSearcher } = await import('./web-searcher.js')
		const create = mock.fn(async (input: { max_output_tokens: number }) => {
			if (input.max_output_tokens === 1_000) {
				return {
					output: [{ type: 'web_search_call', status: 'completed' }],
					usage: { input_tokens: 10, output_tokens: 1_000 },
					output_text: '{"enrichment":"truncated',
				}
			}
			return {
				output: [{ type: 'web_search_call', status: 'completed' }],
				usage: { input_tokens: 10, output_tokens: 20 },
				output_text: '{"enrichment":"Useful result"}',
			}
		})
		const client = { responses: { create } } as unknown as OpenAI
		const searcher = createWebSearcher(client, { agentName: 'Aurora' })

		const result = await searcher.search('topic', [])

		assert.equal(result, 'Useful result')
		assert.equal(create.mock.calls.length, 2)
	})

	it('addresses the agent by name in the prompt and labels its turns', async () => {
		const { createWebSearcher } = await import('./web-searcher.js')
		const create = mock.fn(async (_input: { instructions: string; input: string }) => ({
			output: [{ type: 'web_search_call', status: 'completed' }],
			usage: { input_tokens: 10, output_tokens: 20 },
			output_text: '{"enrichment":"ok"}',
		}))
		const client = { responses: { create } } as unknown as OpenAI
		const searcher = createWebSearcher(client, { agentName: 'Arlo' })

		await searcher.search('topic', [
			{ role: 'agent', content: 'How can I help?' },
			{ role: 'user', content: 'Tell me about topic' },
		])

		const request = create.mock.calls[0].arguments[0]
		assert.match(request.instructions, /Arlo/)
		assert.doesNotMatch(request.instructions, /Aurora|insurance/i)
		assert.match(request.input, /Arlo: "How can I help\?"/)
	})
	it('requires a tool call and accepts only a completed search in the final response', async () => {
		for (const output of [
			[],
			[{ type: 'web_search_call', status: 'failed' }],
			[{ type: 'web_search_call', status: 'searching' }],
		]) {
			const create = mock.fn(async (_input: { tool_choice: string }) => ({
				output,
				output_text: '{"enrichment":"Plausible but unverified result"}',
			}))
			const searcher = createWebSearcher({ responses: { create } } as unknown as OpenAI, { agentName: 'Arlo' })
			assert.equal(await searcher.search('current score', []), null)
			assert.equal(create.mock.calls[0].arguments[0].tool_choice, 'required')
		}
	})

	it('does not reuse search evidence from a discarded truncated response', async () => {
		const create = mock.fn(async (input: { max_output_tokens: number }) =>
			input.max_output_tokens === 1_000
				? {
						output: [{ type: 'web_search_call', status: 'completed' }],
						status: 'incomplete',
						output_text: '{"enrichment":"Partial answer"}',
					}
				: { output: [], output_text: '{"enrichment":"Unsupported retry"}' },
		)
		const searcher = createWebSearcher({ responses: { create } } as unknown as OpenAI, { agentName: 'Arlo' })
		assert.equal(await searcher.search('current score', []), null)
		assert.equal(create.mock.calls.length, 2)
	})

	it('rejects an oversized handoff without cutting off its caveats', async () => {
		const create = mock.fn(async () => ({
			output: [{ type: 'web_search_call', status: 'completed' }],
			output_text: JSON.stringify({ enrichment: Array(151).fill('word').join(' ') }),
		}))
		const searcher = createWebSearcher({ responses: { create } } as unknown as OpenAI, { agentName: 'Arlo' })
		assert.equal(await searcher.search('topic', []), null)
	})

	it('provides authoritative caller time or a labeled UTC fallback', async () => {
		const create = mock.fn(async (_input: { input: string }) => ({
			output: [{ type: 'web_search_call', status: 'completed' }],
			output_text: '{"enrichment":"Source reports a result."}',
		}))
		const searcher = createWebSearcher({ responses: { create } } as unknown as OpenAI, { agentName: 'Arlo' })
		await searcher.search('last night', [], '2030-01-02 09:00 Pacific/Auckland')
		assert.match(create.mock.calls[0].arguments[0].input, /2030-01-02 09:00 Pacific\/Auckland/)
		await searcher.search('last night', [])
		assert.match(
			create.mock.calls[1].arguments[0].input,
			/Current date\/time\n\d{4}-.*UTC fallback; caller timezone unknown/,
		)
	})
})
