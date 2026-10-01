import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { shouldUseCarefulEndpointing } from './endpointing-policy.js'

describe('shouldUseCarefulEndpointing', () => {
	it('fires when the agent asks for a value read out in pieces', () => {
		for (const line of [
			"What's the best email address for you?",
			'And what phone number should we call you back on?',
			'Could you spell your last name for me?',
			'Go ahead and read me the confirmation number.',
			"What's your date of birth?",
			'Can I get the zip code on the account?',
		]) {
			assert.ok(shouldUseCarefulEndpointing(line), line)
		}
	})

	it('stays off for ordinary questions and statements', () => {
		for (const line of [
			'Does Tuesday at three work for you?',
			"I've sent the confirmation to your email.",
			'Your phone number is on file, so no need to repeat it.',
			'How can I help today?',
			'',
		]) {
			assert.ok(!shouldUseCarefulEndpointing(line), line)
		}
	})
})
