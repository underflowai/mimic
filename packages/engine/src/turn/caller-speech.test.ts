import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyCallerSpeech } from './caller-speech.js'

describe('classifyCallerSpeech', () => {
	it('treats listening noises and short acknowledgements as backchannels', () => {
		for (const text of [
			'Mm-hmm.',
			'uh-huh',
			'Yeah.',
			'right',
			'Okay.',
			'oh okay',
			'I see.',
			'Got it.',
			'yeah yeah',
			'okay sure',
			'yes',
		]) {
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
			'hang on, let me grab my calendar',
		]) {
			assert.equal(classifyCallerSpeech(text), 'speech', text)
		}
	})

	it('treats a question as speech even when the words would otherwise pass', () => {
		for (const text of ['Right?', 'okay?', 'Yeah?', 'really?']) {
			assert.equal(classifyCallerSpeech(text), 'speech', text)
		}
	})

	it('does not let sentence-starting fragments pass as backchannels', () => {
		assert.equal(classifyCallerSpeech('I'), 'speech')
		assert.equal(classifyCallerSpeech('got'), 'speech')
	})

	it('never classifies more than four words as a backchannel', () => {
		assert.equal(classifyCallerSpeech('yeah yeah okay right sure'), 'speech')
	})

	it('returns none for empty or punctuation-only text', () => {
		assert.equal(classifyCallerSpeech(''), 'none')
		assert.equal(classifyCallerSpeech(' ... '), 'none')
		assert.equal(classifyCallerSpeech('?'), 'none')
	})
})
