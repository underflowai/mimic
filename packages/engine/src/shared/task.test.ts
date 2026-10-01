import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { coalesceRuns, latestWinsQueue, singleFlight } from './task.js'

function deferred<T>() {
	let resolve: (value: T) => void = () => {}
	let reject: (reason?: unknown) => void = () => {}
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

describe('task primitives', () => {
	it('singleFlight drops concurrent invocations while one is running', async () => {
		const gate = deferred<void>()
		let calls = 0
		const run = singleFlight(async () => {
			calls++
			await gate.promise
			return calls
		})

		const first = run()
		const second = run()
		assert.equal(calls, 1)
		gate.resolve()

		assert.equal(await first, 1)
		assert.equal(await second, null)
	})

	it('latestWinsQueue keeps only the latest pending argument', async () => {
		const firstGate = deferred<void>()
		const seen: number[] = []
		const enqueue = latestWinsQueue(async (value: number) => {
			seen.push(value)
			if (value === 1) {
				await firstGate.promise
			}
		})

		enqueue(1)
		enqueue(2)
		enqueue(3)
		firstGate.resolve()

		await new Promise<void>((resolve) => setTimeout(resolve, 20))
		assert.deepEqual(seen, [1, 3])
	})

	it('latestWinsQueue calls onError when fn rejects', async () => {
		const errors: Error[] = []
		const gate = deferred<void>()
		const enqueue = latestWinsQueue(
			async (value: number) => {
				if (value === 42) {
					throw new Error('boom')
				}
				await gate.promise
			},
			(err) => errors.push(err),
		)

		enqueue(42)
		await new Promise<void>((resolve) => setTimeout(resolve, 20))

		assert.equal(errors.length, 1)
		assert.equal(errors[0]!.message, 'boom')
	})

	it('coalesceRuns collapses requests made during a run into one follow-up run', async () => {
		const gate = deferred<void>()
		let runs = 0
		const schedule = coalesceRuns(async () => {
			runs++
			if (runs === 1) await gate.promise
		})

		schedule()
		schedule()
		schedule()
		schedule()
		assert.equal(runs, 1, 'only the first request starts immediately')

		gate.resolve()
		await new Promise<void>((resolve) => setTimeout(resolve, 20))
		assert.equal(runs, 2, 'all requests made during the run collapse into one follow-up')
	})

	it('coalesceRuns reports failures through onError and keeps accepting work', async () => {
		const errors: Error[] = []
		let runs = 0
		const schedule = coalesceRuns(
			async () => {
				runs++
				if (runs === 1) throw new Error('boom')
			},
			(err) => errors.push(err),
		)

		schedule()
		await new Promise<void>((resolve) => setTimeout(resolve, 20))
		schedule()
		await new Promise<void>((resolve) => setTimeout(resolve, 20))

		assert.equal(runs, 2)
		assert.equal(errors.length, 1)
		assert.equal(errors[0]!.message, 'boom')
	})

	it('latestWinsQueue does not crash on rejection without onError', async () => {
		const seen: number[] = []
		const enqueue = latestWinsQueue(async (value: number) => {
			if (value === 42) {
				throw new Error('boom')
			}
			seen.push(value)
		})

		enqueue(42)
		await new Promise<void>((resolve) => setTimeout(resolve, 20))

		enqueue(7)
		await new Promise<void>((resolve) => setTimeout(resolve, 20))

		assert.deepEqual(seen, [7])
	})
})
