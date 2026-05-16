import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { shouldRunLiveMimicTests } from '#test/support/live-test-gate.js'
import { canFastPathPromote, classifyEagerPromotion } from './eager-promotion-classifier.js'

describe('canFastPathPromote — tiered heuristic', () => {
	const cases: Array<{ description: string; spec: string; final: string; expected: boolean }> = [
		// Tier 1: normalized exact match
		{ description: 'identical transcripts', spec: 'I need help', final: 'I need help', expected: true },
		{
			description: 'trailing punctuation difference',
			spec: 'I need help with my account',
			final: 'I need help with my account.',
			expected: true,
		},
		{ description: 'case difference', spec: 'Tell me more', final: 'tell me more', expected: true },

		// Tier 2: filler-word stripping
		{
			description: 'filler inserted mid-sentence',
			spec: 'We mostly do commercial auto',
			final: 'We mostly do, uh, commercial auto',
			expected: true,
		},
		{
			description: 'leading filler added',
			spec: 'I need help with my account',
			final: 'Yeah, uh, I need help with my account',
			expected: true,
		},
		{
			description: 'multiple fillers scattered',
			spec: 'We had three claims last year',
			final: 'So, um, we had like three claims last year',
			expected: true,
		},
		{
			description: 'you know as filler',
			spec: 'The cert holder needs to be updated',
			final: 'You know, the cert holder needs to be updated',
			expected: true,
		},
		{
			description: 'i mean as filler',
			spec: 'We get about forty calls a day',
			final: 'I mean, we get about forty calls a day',
			expected: true,
		},

		// Tier 3: prefix containment with short tail
		{
			description: 'one trailing word',
			spec: 'I work at a car dealership',
			final: 'I work at a car dealership in Denver',
			expected: true,
		},
		{
			description: 'two trailing words',
			spec: 'We handle insurance',
			final: 'We handle insurance for trucking',
			expected: true,
		},
		{
			description: 'prefix + filler + short tail',
			spec: 'I run a clinic',
			final: 'Yeah, I run a clinic in Florida',
			expected: true,
		},

		// Should fall through (NOT fast-path promoted)
		{
			description: 'long tail appended (new question)',
			spec: 'Yeah this is a good time to talk',
			final: 'Yeah this is a good time to talk. Do you know who won the Nuggets game?',
			expected: false,
		},
		{
			description: 'completely different topic',
			spec: 'Tell me about your coverage options',
			final: 'Actually, what time do you close today?',
			expected: false,
		},
		{
			description: 'caller changes request mid-sentence',
			spec: 'Can you look up our',
			final: "Can you look up our — actually, never mind, let's move on",
			expected: false,
		},
		{
			description: 'new question appended without draft',
			spec: 'Yeah, good time to talk. Before we start,',
			final: 'Yeah, good time to talk. Before we start, do you know the Nuggets score?',
			expected: false,
		},
		{
			description: 'three trailing substantive words exceeds limit',
			spec: 'I need help',
			final: 'I need help with my large account',
			expected: false,
		},
	]

	for (const { description, spec, final, expected } of cases) {
		it(`${description} → ${expected ? 'promote' : 'fall-through'}`, () => {
			assert.equal(canFastPathPromote(spec, final), expected)
		})
	}
})

describe('classifyEagerPromotion — real API', () => {
	async function getClient() {
		const OpenAI = (await import('openai')).default
		const { config } = await import('#engine/config.js')
		const apiKey = config.mimic.openai.apiKey
		if (!apiKey || apiKey === 'test-openai-key-for-unit-tests') return null
		return new OpenAI({ apiKey })
	}

	const promoteCases = [
		{
			description: 'same thought, minor wording change',
			specTranscript: 'Yeah, I work at a car dealership',
			finalTranscript: 'Yeah, I work at a car dealership in Denver',
			draftResponse: 'Got it — car dealership. What kind of vehicles do you mostly deal with?',
			expected: true,
		},
		{
			description: 'filler words added',
			specTranscript: 'We mostly do commercial auto',
			finalTranscript: 'We mostly do, uh, commercial auto',
			draftResponse: 'Commercial auto — that makes sense. How many vehicles are in your fleet?',
			expected: true,
		},
		{
			description: 'new question added at end',
			specTranscript: 'Yeah. This is a good time to talk. But, uh, before we get started,',
			finalTranscript:
				'Yeah. This is a good time to talk. But, uh, before we get started, do you know who won the Nuggets game?',
			draftResponse: "Great! So I don't know much about what you do — mind telling me a bit about your business?",
			expected: false,
		},
		{
			description: 'completely different topic',
			specTranscript: 'Tell me about your coverage options',
			finalTranscript: 'Actually, what time do you close today?',
			draftResponse: 'We offer several tiers of coverage depending on your fleet size.',
			expected: false,
		},
		{
			description: 'caller changes request mid-sentence',
			specTranscript: 'Can you look up our',
			finalTranscript: "Can you look up our — actually, never mind, let's move on",
			draftResponse: "Sure, let me pull up your company info. What's the name?",
			expected: false,
		},
	]

	for (const { description, specTranscript, finalTranscript, draftResponse, expected } of promoteCases) {
		it(`3-way: ${description} → ${expected ? 'promote' : 'discard'}`, async (ctx) => {
			if (!shouldRunLiveMimicTests()) {
				ctx.skip()
				return
			}
			const client = await getClient()
			if (!client) {
				ctx.skip()
				return
			}

			const result = await classifyEagerPromotion(client, specTranscript, finalTranscript, draftResponse)
			assert.equal(result, expected)
		})
	}

	const twoWayCases = [
		{
			description: 'same thought without draft',
			specTranscript: 'I work at a car dealership',
			finalTranscript: 'I work at a car dealership in Denver',
			expected: true,
		},
		{
			description: 'new question without draft',
			specTranscript: 'Yeah, good time to talk. Before we start,',
			finalTranscript: 'Yeah, good time to talk. Before we start, do you know the Nuggets score?',
			expected: false,
		},
	]

	for (const { description, specTranscript, finalTranscript, expected } of twoWayCases) {
		it(`2-way: ${description} → ${expected ? 'promote' : 'discard'}`, async (ctx) => {
			if (!shouldRunLiveMimicTests()) {
				ctx.skip()
				return
			}
			const client = await getClient()
			if (!client) {
				ctx.skip()
				return
			}

			const result = await classifyEagerPromotion(client, specTranscript, finalTranscript, null)
			assert.equal(result, expected)
		})
	}
})
