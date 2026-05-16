import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { createListenTranscriber } from './listen-transcriber.js'

describe('createListenTranscriber', () => {
	it('returns the expected public API', () => {
		const transcriber = createListenTranscriber()
		assert.equal(typeof transcriber.connect, 'function')
		assert.equal(typeof transcriber.sendAudio, 'function')
		assert.equal(typeof transcriber.configure, 'function')
		assert.equal(typeof transcriber.on, 'function')
		assert.equal(typeof transcriber.off, 'function')
		assert.equal(typeof transcriber.listTurns, 'function')
		assert.equal(typeof transcriber.getDurationSeconds, 'function')
		assert.equal(typeof transcriber.close, 'function')
	})

	it('starts with an empty turn list', () => {
		const transcriber = createListenTranscriber()
		assert.deepEqual(transcriber.listTurns(), [])
	})

	it('getDurationSeconds returns 0 before connect', () => {
		const transcriber = createListenTranscriber()
		assert.equal(transcriber.getDurationSeconds(), 0)
	})

	it('listTurns returns a copy, not a mutable reference', () => {
		const transcriber = createListenTranscriber()
		const turns1 = transcriber.listTurns()
		const turns2 = transcriber.listTurns()
		assert.notEqual(turns1, turns2)
	})

	it('does not expose TTS, director, or audio output methods', () => {
		const transcriber = createListenTranscriber() as Record<string, unknown>
		assert.equal(transcriber.onSendAudio, undefined)
		assert.equal(transcriber.onClearBuffer, undefined)
		assert.equal(transcriber.onSuspendAudio, undefined)
		assert.equal(transcriber.start, undefined)
		assert.equal(transcriber.handlePlaybackConfirmed, undefined)
	})
})

describe('createListenTranscriber callback registration', () => {
	it('on("turnComplete") accepts a callback without throwing', () => {
		const transcriber = createListenTranscriber()
		const fn = mock.fn()
		assert.doesNotThrow(() => transcriber.on('turnComplete', fn))
	})

	it('on("error") accepts a callback without throwing', () => {
		const transcriber = createListenTranscriber()
		const fn = mock.fn()
		assert.doesNotThrow(() => transcriber.on('error', fn))
	})

	it('close can be called without prior connect', () => {
		const transcriber = createListenTranscriber()
		assert.doesNotThrow(() => transcriber.close())
	})
})
