import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type OpenAI from 'openai'

import { extractCallResult, type ExtractionInput } from './result-extractor.js'

function createClient(content: string, extra: { finish_reason?: string; refusal?: string } = {}) {
	let request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming | undefined
	const client = {
		chat: {
			completions: {
				create: async (input: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) => {
					request = input
					return {
						choices: [{ finish_reason: extra.finish_reason ?? 'stop', message: { content, refusal: extra.refusal } }],
					}
				},
			},
		},
	} as unknown as OpenAI
	return { client, getRequest: () => request! }
}

const input: ExtractionInput = {
	goal: 'Record whether the caller wants a follow-up.',
	transcript: [{ role: 'user', content: 'I have a question about my account.' }],
	results: { wantsFollowUp: { type: 'boolean', description: 'Whether the caller requested follow-up' } },
}

describe('extractCallResult', () => {
	it('represents unknown required and optional fields with null in a strict-compatible schema', async () => {
		const mock = createClient(
			JSON.stringify({
				wantsFollowUp: null,
				preferredDay: null,
				goalAchieved: false,
				goalAchievedReason: 'Not discussed.',
			}),
		)
		const extraction = await extractCallResult(mock.client, {
			...input,
			results: { ...input.results, preferredDay: { type: 'string', description: 'Preferred day', optional: true } },
		})
		assert.deepEqual(extraction.result, { wantsFollowUp: null, preferredDay: null })
		const format = mock.getRequest().response_format
		assert.equal(format?.type, 'json_schema')
		if (format?.type !== 'json_schema') throw new Error('Expected structured output')
		const schema = format.json_schema.schema as { required: string[]; properties: Record<string, { type: unknown }> }
		assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)))
		assert.deepEqual(schema.properties.wantsFollowUp.type, ['boolean', 'null'])
		assert.deepEqual(schema.properties.preferredDay.type, ['string', 'null'])
	})

	it('reports tool execution success to the model, including when it is unknown', async () => {
		const mock = createClient(
			JSON.stringify({ wantsFollowUp: null, goalAchieved: false, goalAchievedReason: 'Unverified.' }),
		)
		await extractCallResult(mock.client, {
			...input,
			toolCalls: [
				{ name: 'sendFollowUp', input: {}, output: {}, success: undefined },
				{ name: 'lookup', input: {}, output: {}, success: true },
			],
		})
		const content = String(mock.getRequest().messages[1].content)
		assert.ok(content.includes('Tool: sendFollowUp\nExecution success: unknown'))
		assert.ok(content.includes('Tool: lookup\nExecution success: true'))
	})

	for (const [label, content, extra] of [
		['malformed', '{"wantsFollowUp":', {}],
		['missing required evidence fields', '{"goalAchieved":true,"goalAchievedReason":"done"}', {}],
		['truncated', '{"wantsFollowUp":true,"goalAchieved":true}', { finish_reason: 'length' }],
		['refused', '{"wantsFollowUp":true,"goalAchieved":true}', { refusal: 'Cannot extract.' }],
	] as const) {
		it(`does not manufacture known fields or goal success from ${label} extraction`, async () => {
			const mock = createClient(content, extra)
			const extraction = await extractCallResult(mock.client, input)
			assert.equal(extraction.result.wantsFollowUp, null)
			assert.equal(extraction.goalAchieved, false)
			assert.match(extraction.goalAchievedReason, /could not be verified/)
		})
	}

	it('does not convert a model string into an established boolean', async () => {
		const mock = createClient(
			JSON.stringify({ wantsFollowUp: 'false', goalAchieved: false, goalAchievedReason: 'Unknown.' }),
		)
		const extraction = await extractCallResult(mock.client, input)
		assert.equal(extraction.result.wantsFollowUp, null)
		assert.equal(extraction.goalAchieved, false)
	})
})
