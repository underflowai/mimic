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

	it('constrains enums and arrays in the schema and keeps only values that fit', async () => {
		const mock = createClient(
			JSON.stringify({
				outcome: 'rescheduled',
				concerns: ['price', 'timing'],
				badOutcome: 'maybe',
				badList: ['ok', 3],
				goalAchieved: true,
				goalAchievedReason: 'Rescheduled.',
			}),
		)
		const extraction = await extractCallResult(mock.client, {
			goal: 'Record the outcome.',
			transcript: [],
			results: {
				outcome: { type: 'string', enum: ['confirmed', 'rescheduled'], description: 'what they decided' },
				concerns: { type: 'array', items: 'string', description: 'what worried them' },
				badOutcome: { type: 'string', enum: ['yes', 'no'], description: 'a field the model answered off-list' },
				badList: { type: 'array', items: 'string', description: 'a list with a wrong element type' },
			},
		})

		const schema = (mock.getRequest().response_format as { json_schema: { schema: Record<string, unknown> } })
			.json_schema.schema
		const properties = schema.properties as Record<string, Record<string, unknown>>
		assert.deepEqual(properties.outcome.anyOf, [
			{ type: 'string', enum: ['confirmed', 'rescheduled'] },
			{ type: 'null' },
		])
		assert.deepEqual(properties.concerns.type, ['array', 'null'])
		assert.deepEqual(properties.concerns.items, { type: 'string' })

		const prompt = String(mock.getRequest().messages[1]?.content)
		assert.match(prompt, /outcome \(one of: confirmed, rescheduled; unknown = null\)/)
		assert.match(prompt, /concerns \(list of strings; unknown = null\)/)

		// A response that breaks the schema anywhere establishes nothing: unknown, not approximately right.
		assert.deepEqual(extraction.result, { outcome: null, concerns: null, badOutcome: null, badList: null })
		assert.equal(extraction.goalAchieved, false)
	})

	it('accepts enum and array values that fit', async () => {
		const mock = createClient(
			JSON.stringify({ outcome: 'confirmed', concerns: [], goalAchieved: true, goalAchievedReason: 'Confirmed.' }),
		)
		const extraction = await extractCallResult(mock.client, {
			goal: 'Record the outcome.',
			transcript: [],
			results: {
				outcome: { type: 'string', enum: ['confirmed', 'rescheduled'], description: 'what they decided' },
				concerns: { type: 'array', items: 'string', description: 'what worried them' },
			},
		})
		assert.deepEqual(extraction.result, { outcome: 'confirmed', concerns: [] })
		assert.equal(extraction.goalAchieved, true)
	})
})
