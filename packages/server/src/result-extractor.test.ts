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

	it('does not tell the model that a field is unfilled before extraction', async () => {
		const mock = createClient(
			JSON.stringify({ wantsFollowUp: false, goalAchieved: false, goalAchievedReason: 'Caller declined.' }),
		)
		const extraction = await extractCallResult(mock.client, {
			...input,
			successCondition: { type: 'field_filled', fieldName: 'wantsFollowUp' },
		})
		const message = mock.getRequest().messages.find((m) => m.role === 'user')
		assert.ok(!String(message?.content).includes('goalAchieved=false'))
		assert.equal(extraction.result.wantsFollowUp, false)
		assert.equal(extraction.goalAchieved, true, 'An explicit false is a filled boolean; unknown is null')
	})

	for (const success of [undefined, false, true]) {
		it(`requires explicit tool execution success for tool_called (${success})`, async () => {
			const mock = createClient(
				JSON.stringify({ wantsFollowUp: null, goalAchieved: true, goalAchievedReason: 'Assistant said done.' }),
			)
			const extraction = await extractCallResult(mock.client, {
				...input,
				toolCalls: [{ name: 'sendFollowUp', input: {}, output: {}, success }],
				successCondition: { type: 'tool_called', toolName: 'sendFollowUp' },
			})
			assert.equal(extraction.goalAchieved, success === true)
			if (success === undefined)
				assert.ok(String(mock.getRequest().messages[1].content).includes('Execution success: unknown'))
		})
	}

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
		const extraction = await extractCallResult(mock.client, {
			...input,
			successCondition: { type: 'field_filled', fieldName: 'wantsFollowUp' },
		})
		assert.equal(extraction.result.wantsFollowUp, null)
		assert.equal(extraction.goalAchieved, false)
	})
})
