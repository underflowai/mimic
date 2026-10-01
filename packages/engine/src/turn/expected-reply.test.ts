import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyExpectedReply } from './expected-reply.js'

describe('classifyExpectedReply', () => {
	it('classifies closed yes/no questions as short', () => {
		assert.equal(classifyExpectedReply('Does 2pm work for you?'), 'short')
		assert.equal(classifyExpectedReply('Is that the right address?'), 'short')
		assert.equal(classifyExpectedReply('Can you still make it Monday?'), 'short')
		assert.equal(classifyExpectedReply('Would Thursday be better?'), 'short')
	})

	it('classifies tag questions as short', () => {
		assert.equal(classifyExpectedReply("We'll see you at two, right?"), 'short')
		assert.equal(classifyExpectedReply('So we are all set, okay?'), 'short')
	})

	it('classifies A-or-B choices as short', () => {
		assert.equal(classifyExpectedReply('Morning or afternoon?'), 'short')
		assert.equal(classifyExpectedReply('Would you prefer Tuesday or Thursday?'), 'short')
	})

	it('classifies open questions as long', () => {
		assert.equal(classifyExpectedReply('What happened with the last delivery?'), 'long')
		assert.equal(classifyExpectedReply('How did the appointment go?'), 'long')
		assert.equal(classifyExpectedReply('Why do you think it failed?'), 'long')
	})

	it('classifies statements as neutral', () => {
		assert.equal(classifyExpectedReply('Great, you are all booked for Monday at two.'), 'neutral')
		assert.equal(classifyExpectedReply("Perfect, I'll send the confirmation now."), 'neutral')
	})

	it('classifies only the final question of a multi-sentence turn', () => {
		assert.equal(classifyExpectedReply('What a day. Does Monday still work?'), 'short')
		assert.equal(classifyExpectedReply('Okay, noted. How would you like to proceed?'), 'long')
	})

	it('handles trailing quotes and empty input', () => {
		assert.equal(classifyExpectedReply('Did you say "Baker Street?"'), 'short')
		assert.equal(classifyExpectedReply(''), 'neutral')
		assert.equal(classifyExpectedReply('?'), 'neutral')
	})

	it('unrecognized question shapes stay neutral', () => {
		assert.equal(classifyExpectedReply('Sorry?'), 'neutral')
	})
})
