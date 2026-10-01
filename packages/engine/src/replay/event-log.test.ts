import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createCallEventRecorder, parseEventLog, serializeEventLog } from './event-log.js'

describe('call event recorder', () => {
	it('records events with monotonic seq and relative timestamps', () => {
		let now = 10_000
		const recorder = createCallEventRecorder({ now: () => now })

		recorder.record('vad_speech_start')
		now += 250
		recorder.record('caller_turn_complete', { transcript: 'hello', confidence: 0.92 })

		const events = recorder.snapshot()
		assert.equal(events.length, 2)
		assert.deepEqual(events[0], { seq: 0, atMs: 0, type: 'vad_speech_start', data: {} })
		assert.deepEqual(events[1], {
			seq: 1,
			atMs: 250,
			type: 'caller_turn_complete',
			data: { transcript: 'hello', confidence: 0.92 },
		})
	})

	it('snapshot returns a copy', () => {
		const recorder = createCallEventRecorder()
		recorder.record('a')
		const first = recorder.snapshot()
		recorder.record('b')
		assert.equal(first.length, 1)
		assert.equal(recorder.snapshot().length, 2)
	})
})

describe('event log serialization', () => {
	it('round-trips through JSONL', () => {
		const recorder = createCallEventRecorder({ now: () => 0 })
		recorder.record('vad_speech_start')
		recorder.record('caller_update', { transcript: 'multi\nline "quoted"' })
		const events = recorder.snapshot()

		const jsonl = serializeEventLog(events)
		assert.equal(jsonl.split('\n').filter(Boolean).length, 2)
		assert.deepEqual(parseEventLog(jsonl), events)
	})

	it('parse skips blank lines and rejects malformed records', () => {
		const parsed = parseEventLog('\n{"seq":0,"atMs":1,"type":"x","data":{}}\n\n')
		assert.equal(parsed.length, 1)
		assert.throws(() => parseEventLog('{"seq":"nope"}'))
	})

	it('serializes an empty log to an empty string', () => {
		assert.equal(serializeEventLog([]), '')
	})
})
