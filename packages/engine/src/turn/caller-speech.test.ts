import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyCallerSpeech, isBackchannelOnly, isHoldRequest } from './caller-speech.js'

describe('classifyCallerSpeech', () => {
	it('treats listening noises as backchannels', () => {
		for (const text of ['Mm-hmm.', 'uh-huh', 'Yeah.', 'right', 'Okay.', 'oh okay', 'I see.', 'Got it.', 'yeah yeah']) {
			assert.equal(classifyCallerSpeech(text), 'backchannel', text)
		}
	})

	it('treats anything with content words as speech', () => {
		for (const text of [
			'wait',
			'no',
			'hold on',
			'yeah but',
			'actually',
			'okay so what about friday',
			'stop',
			'yeah I think so but can we do thursday',
		]) {
			assert.equal(classifyCallerSpeech(text), 'speech', text)
		}
	})

	it('does not let sentence-starting fragments pass as backchannels', () => {
		assert.equal(classifyCallerSpeech('I'), 'speech')
		assert.equal(classifyCallerSpeech('got'), 'speech')
	})

	it('reads short affirmatives as answers when the agent just asked a question', () => {
		const agentDraft = 'Does Tuesday at three work for you?'
		assert.equal(classifyCallerSpeech('yeah', { agentDraft }), 'answer')
		assert.equal(classifyCallerSpeech('okay sure', { agentDraft }), 'answer')
		assert.equal(classifyCallerSpeech('mm-hmm', { agentDraft }), 'backchannel')
		assert.equal(classifyCallerSpeech('yeah', { agentDraft: 'Let me check that for you.' }), 'backchannel')
	})

	it('returns none for empty or punctuation-only text', () => {
		assert.equal(classifyCallerSpeech(''), 'none')
		assert.equal(classifyCallerSpeech(' ... '), 'none')
	})

	it('isBackchannelOnly mirrors the backchannel class', () => {
		assert.ok(isBackchannelOnly('Right, right.'))
		assert.ok(!isBackchannelOnly('Right, so about the invoice'))
		assert.ok(!isBackchannelOnly('yes', { agentDraft: 'Shall I book it?' }))
	})
})

describe('isHoldRequest', () => {
	it('matches explicit requests to wait', () => {
		for (const text of [
			'Hold on a second.',
			'hang on, let me grab my calendar',
			'one sec',
			'Give me a minute.',
			'bear with me',
			'let me check my schedule real quick',
			'can you hold?',
			'just a moment please',
		]) {
			assert.ok(isHoldRequest(text), text)
		}
	})

	it('ignores ordinary turns', () => {
		for (const text of ['wait, what?', 'Tuesday works', 'I need to reschedule', 'no', '']) {
			assert.ok(!isHoldRequest(text), text)
		}
	})
})
