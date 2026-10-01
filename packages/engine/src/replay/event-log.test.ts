import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createActor, createMachine, sendTo } from 'xstate'

import { createCallEventRecorder, parseEventLog, sanitizeEventData, serializeEventLog } from './event-log.js'

function fakeClock(start = 1_000) {
	let now = start
	return {
		clock: { now: () => now },
		advance(ms: number) {
			now += ms
		},
	}
}

describe('event log: sanitizer', () => {
	it('keeps primitives, one nested level, and short primitive arrays; drops the rest', () => {
		const sanitized = sanitizeEventData({
			type: 'caller_update',
			transcript: 'hello',
			confidence: 0.42,
			flag: true,
			missing: null,
			nested: { a: 1, b: 'two', deeper: { c: 3 }, fn: () => 1 },
			list: ['a', 'b'],
			nestedList: [{ a: 1 }],
			buffer: Buffer.from('audio'),
			handle: new AbortController(),
			fn: () => 1,
			nan: Number.NaN,
		})
		assert.deepEqual(sanitized, {
			transcript: 'hello',
			confidence: 0.42,
			flag: true,
			missing: null,
			nested: { a: 1, b: 'two' },
			list: ['a', 'b'],
			nan: 'NaN',
		})
	})

	it('truncates long strings and long arrays', () => {
		const sanitized = sanitizeEventData({ text: 'x'.repeat(5_000), list: Array.from({ length: 50 }, (_, i) => i) })
		assert.equal((sanitized.text as string).length, 1_001)
		assert.ok((sanitized.text as string).endsWith('…'))
		assert.equal((sanitized.list as number[]).length, 20)
	})
})

describe('event log: recorder', () => {
	it('records with sequence numbers and clock offsets, and round-trips through JSONL', () => {
		const { clock, advance } = fakeClock()
		const recorder = createCallEventRecorder({ clock })
		recorder.record('vad_speech_start')
		advance(250)
		recorder.record('caller_turn_complete', { transcript: 'yes please', confidence: 0.91 })

		const events = recorder.snapshot()
		assert.deepEqual(events, [
			{ seq: 0, atMs: 0, type: 'vad_speech_start', data: {} },
			{ seq: 1, atMs: 250, type: 'caller_turn_complete', data: { transcript: 'yes please', confidence: 0.91 } },
		])

		const jsonl = serializeEventLog(events)
		assert.equal(jsonl.split('\n').filter(Boolean).length, 2)
		assert.deepEqual(parseEventLog(jsonl), events)
	})

	it('stops recording at the cap and marks the truncation once', () => {
		const recorder = createCallEventRecorder({ clock: fakeClock().clock, maxEvents: 3 })
		for (let i = 0; i < 10; i++) recorder.record('tick', { i })
		const events = recorder.snapshot()
		assert.equal(events.length, 4)
		assert.equal(events[3]!.type, 'event_log_truncated')
		assert.deepEqual(events[3]!.data, { maxEvents: 3 })
		assert.equal(recorder.size(), 4)
	})

	it('taps every event an actor system receives, tagged with the receiving actor id', () => {
		const child = createMachine({
			id: 'turnActor',
			initial: 'idle',
			states: { idle: { on: { interrupt: 'done' } }, done: {} },
		})
		const machine = createMachine({
			id: 'call',
			initial: 'listening',
			invoke: { id: 'turnActor', src: child },
			states: {
				listening: {
					on: {
						caller_turn_complete: { actions: ({ event }) => void event },
						interrupt: { actions: sendTo('turnActor', ({ event }) => event) },
					},
				},
			},
		})

		const recorder = createCallEventRecorder({ clock: fakeClock().clock })
		const actor = createActor(machine, { inspect: recorder.inspect }).start()
		actor.send({ type: 'caller_turn_complete', transcript: 'hi there', confidence: 0.8, audio: Buffer.alloc(4) })
		actor.send({ type: 'interrupt', reason: 'caller_speech' })
		actor.stop()

		const events = recorder.snapshot()
		const types = events.map((e) => `${e.actor}:${e.type}`)
		assert.ok(types.includes('call:caller_turn_complete'), types.join(','))
		assert.ok(types.includes('call:interrupt'), types.join(','))
		assert.ok(types.includes('turnActor:interrupt'), types.join(','))
		assert.ok(!types.some((t) => t.endsWith(':xstate.init')), 'init events are noise')

		const complete = events.find((e) => e.type === 'caller_turn_complete')!
		assert.deepEqual(complete.data, { transcript: 'hi there', confidence: 0.8 })
	})

	it('rejects malformed log lines', () => {
		assert.throws(() => parseEventLog('{"seq":"x"}'), /invalid event log line/)
	})
})
