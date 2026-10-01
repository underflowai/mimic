import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import type OpenAI from 'openai'
import { z } from 'zod'

import { callBackgroundModel, safeParseJsonWithSchema } from './llm-parse.js'
import { models } from './models.js'

const schema = z.object({ promote: z.boolean() })

type CreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
type Choice = { finish_reason: string; message: { content: string | null; refusal?: string | null } }

function clientReturning(choice: Choice) {
	const create = mock.fn(async (_params: CreateParams) => ({ choices: [choice] }))
	return { client: { chat: { completions: { create } } } as unknown as OpenAI, create }
}

describe('callBackgroundModel', () => {
	it('constrains the reply with a strict JSON schema named after the tag', async () => {
		const { client, create } = clientReturning({ finish_reason: 'stop', message: { content: '{"promote":true}' } })

		const result = await callBackgroundModel(client, 'system', 'user', schema, 'eager-promo', { maxTokens: 50 })

		assert.deepEqual(result, { promote: true })
		const params = create.mock.calls[0]?.arguments[0] as CreateParams
		assert.equal(params.model, models.background.model)
		assert.equal(params.reasoning_effort, models.background.reasoningEffort)
		assert.equal(params.max_completion_tokens, 50)
		const format = params.response_format as OpenAI.ResponseFormatJSONSchema
		assert.equal(format.type, 'json_schema')
		assert.equal(format.json_schema.name, 'eager-promo')
		assert.equal(format.json_schema.strict, true)
		assert.deepEqual(format.json_schema.schema?.required, ['promote'])
		assert.equal(format.json_schema.schema?.additionalProperties, false)
	})

	it('returns null when the reply was cut off at max_completion_tokens', async () => {
		const { client } = clientReturning({ finish_reason: 'length', message: { content: '{"prom' } })
		assert.equal(await callBackgroundModel(client, 'system', 'user', schema, 'eager-promo'), null)
	})

	it('returns null when the model refuses', async () => {
		const { client } = clientReturning({ finish_reason: 'stop', message: { content: null, refusal: 'no' } })
		assert.equal(await callBackgroundModel(client, 'system', 'user', schema, 'eager-promo'), null)
	})

	it('returns null without calling the model when already aborted', async () => {
		const { client, create } = clientReturning({ finish_reason: 'stop', message: { content: '{"promote":true}' } })
		const controller = new AbortController()
		controller.abort()
		assert.equal(
			await callBackgroundModel(client, 's', 'u', schema, 'eager-promo', { signal: controller.signal }),
			null,
		)
		assert.equal(create.mock.calls.length, 0)
	})
})

describe('safeParseJsonWithSchema', () => {
	it('decodes content that matches the schema', () => {
		assert.deepEqual(safeParseJsonWithSchema('{"promote":false}', schema, 'test'), { promote: false })
	})

	it('returns null for malformed JSON or a mismatched shape', () => {
		assert.equal(safeParseJsonWithSchema('{"promote":', schema, 'test'), null)
		assert.equal(safeParseJsonWithSchema('{"promote":"yes"}', schema, 'test'), null)
	})
})
