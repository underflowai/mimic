import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type OpenAI from 'openai'

import { shouldRunLiveMimicTests } from '#test/support/live-test-gate.js'
import { createBackchannelClassifier } from './classifier.js'

function createClient(token: string | null) {
	let request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming | undefined
	const client = {
		chat: {
			completions: {
				create: async (input: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) => {
					request = input
					return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ token }) } }] }
				},
			},
		},
	} as unknown as OpenAI
	return { client, getRequest: () => request! }
}

describe('backchannel classifier boundaries', () => {
	it('retains a request at the beginning of a long caller turn', async () => {
		const mock = createClient(null)
		const classifier = createBackchannelClassifier(mock.client, new AbortController().signal)
		const transcript = `Please do not proceed until I confirm. ${'There are several details to discuss first. '.repeat(12)}`
		assert.equal(await classifier.classify(transcript), null)
		const evidence = JSON.parse(String(mock.getRequest().messages[1].content))
		assert.equal(evidence.callerTranscript, transcript.trim())
	})

	for (const token of ['sure', 'right', 'yeah', 'okay']) {
		it(`rejects an assent token even if a model emits ${token}`, async () => {
			const mock = createClient(token)
			const classifier = createBackchannelClassifier(mock.client, new AbortController().signal)
			assert.equal(await classifier.classify('I need you to cancel the payment'), null)
		})
	}

	it('keeps a neutral listening acknowledgment available', async () => {
		const mock = createClient('uh-huh')
		const classifier = createBackchannelClassifier(mock.client, new AbortController().signal)
		assert.equal(await classifier.classify('There are apples oranges and pears'), 'uh-huh')
	})
})

describe('production backchannel prompt (live API)', () => {
	for (const transcript of [
		'Please go ahead and add those six vehicles to the policy',
		'Could you confirm that my medication is safe to take',
		'I do not want you to sign me up for anything',
		'My father died yesterday and I cannot think clearly',
		'Actually the payment amount is fifteen dollars not fifty',
		'Please stop talking and let me finish explaining',
	]) {
		it(`leaves a full response for: ${transcript}`, async (ctx) => {
			if (!shouldRunLiveMimicTests()) {
				ctx.skip()
				return
			}
			const OpenAI = (await import('openai')).default
			const { config } = await import('#engine/config.js')
			const apiKey = config.mimic.openai.apiKey
			if (!apiKey || apiKey === 'test-openai-key-for-unit-tests') {
				ctx.skip()
				return
			}
			const classifier = createBackchannelClassifier(new OpenAI({ apiKey }), new AbortController().signal)
			assert.equal(await classifier.classify(transcript), null)
		})
	}
})
