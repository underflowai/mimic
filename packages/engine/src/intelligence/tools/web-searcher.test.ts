import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import OpenAI from 'openai'

describe('web-searcher', () => {
	it('createWebSearcher exposes search method', async () => {
		const { createWebSearcher } = await import('./web-searcher.js')
		const client = new OpenAI({ apiKey: 'test-key' })
		const searcher = createWebSearcher(client)
		assert.equal(typeof searcher.search, 'function')
	})

	it('retries when structured output is truncated at token cap', async () => {
		const { createWebSearcher } = await import('./web-searcher.js')
		const create = mock.fn(async (input: { max_output_tokens: number }) => {
			if (input.max_output_tokens === 1_000) {
				return {
					output: [{ type: 'web_search_call' }],
					usage: { input_tokens: 10, output_tokens: 1_000 },
					output_text: '{"enrichment":"truncated',
				}
			}
			return {
				output: [{ type: 'web_search_call' }],
				usage: { input_tokens: 10, output_tokens: 20 },
				output_text: '{"enrichment":"Useful result"}',
			}
		})
		const client = { responses: { create } } as unknown as OpenAI
		const searcher = createWebSearcher(client)

		const result = await searcher.search('topic', [])

		assert.equal(result, 'Useful result')
		assert.equal(create.mock.calls.length, 2)
	})
})
