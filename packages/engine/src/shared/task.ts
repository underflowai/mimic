export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T | null> {
	let inFlight: Promise<T> | null = null

	return async function runSingleFlight() {
		if (inFlight) return null
		const task = Promise.resolve(fn())
		inFlight = task
		try {
			return await task
		} finally {
			if (inFlight === task) {
				inFlight = null
			}
		}
	}
}

/**
 * Runs `fn` at most once at a time. Requests that arrive while it is running
 * collapse into a single follow-up run, so `fn` always ends up observing the
 * latest state without ever running concurrently with itself.
 */
export function coalesceRuns(fn: () => Promise<void>, onError?: (err: Error) => void): () => void {
	const enqueue = latestWinsQueue<true, void>(() => fn(), onError)
	return () => enqueue(true)
}

/**
 * Serializes calls to `fn`. While a call is running, newer arguments replace
 * each other so only the most recent one runs afterwards.
 */
export function latestWinsQueue<A, R>(fn: (arg: A) => Promise<R>, onError?: (err: Error) => void): (arg: A) => void {
	let running = false
	let pendingArg: A | null = null

	async function run(initialArg: A) {
		let currentArg: A | null = initialArg
		running = true
		try {
			while (currentArg !== null) {
				await fn(currentArg)
				currentArg = pendingArg
				pendingArg = null
			}
		} finally {
			running = false
		}
	}

	return function enqueueLatest(arg: A) {
		if (running) {
			pendingArg = arg
			return
		}
		run(arg).catch((err) => {
			if (onError) onError(err instanceof Error ? err : new Error(String(err)))
		})
	}
}
