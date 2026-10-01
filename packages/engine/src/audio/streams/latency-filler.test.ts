import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { DirectorStreamEvent } from '../../shared/streaming-types.js'
import { createLatencyFillerPicker, withLatencyFiller } from './latency-filler.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((res) => {
		resolve = res
	})
	return { promise, resolve }
}

async function* tokens(values: string[], gate?: Promise<void>): AsyncGenerator<DirectorStreamEvent, string> {
	if (gate) await gate
	for (const value of values) yield { type: 'token', value }
	return values.join('')
}

async function collect(events: AsyncGenerator<DirectorStreamEvent, string>) {
	const seen: string[] = []
	let next = await events.next()
	while (!next.done) {
		seen.push(next.value.value)
		next = await events.next()
	}
	return { seen, returned: next.value }
}

describe('withLatencyFiller', () => {
	it('passes tokens through untouched when the model is fast', async () => {
		let injected: string | null = null
		const wrapped = withLatencyFiller(tokens(['Sure, ', 'three works.']), {
			delayMs: 50,
			filler: () => 'Hmm.',
			onInjected: (text) => (injected = text),
		})

		const { seen, returned } = await collect(wrapped.events)
		assert.deepEqual(seen, ['Sure, ', 'three works.'])
		assert.equal(returned, 'Sure, three works.')
		assert.equal(injected, null)
		assert.equal(wrapped.injected(), null)
		assert.ok(wrapped.modelFirstTokenAt() !== null)
	})

	it('speaks a filler when the first token is late, then continues with the model text', async () => {
		const gate = deferred<void>()
		const clockValues = [100, 200, 300]
		const wrapped = withLatencyFiller(tokens(['Three ', 'works.'], gate.promise), {
			delayMs: 10,
			filler: () => 'Let me see.',
			clock: { now: () => clockValues.shift() ?? 999 },
		})

		const first = await wrapped.events.next()
		assert.deepEqual(first.value, { type: 'token', value: 'Let me see. ' })
		assert.equal(wrapped.injected(), 'Let me see.')
		assert.equal(wrapped.modelFirstTokenAt(), null, 'model has not spoken yet')

		gate.resolve()
		const rest = await collect(wrapped.events)
		assert.deepEqual(rest.seen, ['Three ', 'works.'])
		assert.equal(rest.returned, 'Three works.')
		assert.ok(wrapped.modelFirstTokenAt() !== null)
	})

	it('stays silent when the picker returns nothing or the turn was aborted', async () => {
		const gate = deferred<void>()
		const quiet = withLatencyFiller(tokens(['ok'], gate.promise), { delayMs: 5, filler: () => '' })
		const pendingQuiet = quiet.events.next()
		await new Promise((r) => setTimeout(r, 20))
		gate.resolve()
		assert.deepEqual((await pendingQuiet).value, { type: 'token', value: 'ok' })
		assert.equal(quiet.injected(), null)

		const abort = new AbortController()
		const gate2 = deferred<void>()
		const aborted = withLatencyFiller(tokens(['late'], gate2.promise), {
			delayMs: 5,
			filler: () => 'Hmm.',
			signal: abort.signal,
		})
		abort.abort()
		const pendingAborted = aborted.events.next()
		await new Promise((r) => setTimeout(r, 20))
		gate2.resolve()
		assert.deepEqual((await pendingAborted).value, { type: 'token', value: 'late' })
		assert.equal(aborted.injected(), null)
	})

	it('does not count an empty leading delta as the model starting', async () => {
		const gate = deferred<void>()
		async function* source(): AsyncGenerator<DirectorStreamEvent, string> {
			yield { type: 'token', value: '' }
			await gate.promise
			yield { type: 'token', value: 'Real.' }
			return 'Real.'
		}
		const wrapped = withLatencyFiller(source(), { delayMs: 10, filler: () => 'Hmm.' })

		const first = await wrapped.events.next()
		assert.deepEqual(first.value, { type: 'token', value: '' })
		const second = await wrapped.events.next()
		assert.deepEqual(second.value, { type: 'token', value: 'Hmm. ' })
		gate.resolve()
		const rest = await collect(wrapped.events)
		assert.deepEqual(rest.seen, ['Real.'])
	})

	it('propagates early return to the model stream', async () => {
		let finallyRan = false
		async function* source(): AsyncGenerator<DirectorStreamEvent, string> {
			try {
				yield { type: 'token', value: 'a' }
				yield { type: 'token', value: 'b' }
				return 'ab'
			} finally {
				finallyRan = true
			}
		}
		const wrapped = withLatencyFiller(source(), { delayMs: 1000, filler: () => 'Hmm.' })
		await wrapped.events.next()
		await wrapped.events.return('')
		assert.ok(finallyRan)
	})
})

describe('latency filler picker', () => {
	it('draws from one neutral pool regardless of what the caller said, never repeating', () => {
		const pick = createLatencyFillerPicker(() => 0)
		const pool = ['Hmm.', 'Let me see.', 'One sec.']
		assert.ok(pool.includes(pick({ transcript: 'how much is it' })))
		assert.ok(pool.includes(pick({ transcript: 'my name is ola and i am calling about the invoice' })))

		let previous = ''
		for (let i = 0; i < 10; i++) {
			const next = pick({ transcript: 'what about friday' })
			assert.notEqual(next, previous)
			assert.ok(pool.includes(next))
			previous = next
		}
	})

	it('never agrees with the caller: no filler is an acknowledgement', () => {
		const pick = createLatencyFillerPicker()
		for (let i = 0; i < 20; i++) {
			const filler = pick({ transcript: 'cancel my account please' })
			assert.ok(!/^(mm-hmm|yeah|okay|right|sure)/i.test(filler), filler)
		}
	})
})
