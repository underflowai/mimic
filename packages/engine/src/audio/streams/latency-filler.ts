/**
 * Latency filler — masks a slow first token on fresh turns.
 *
 * Wraps the director's token stream. If the model has not produced its
 * first token within `delayMs`, a short neutral filler ("Hmm.", "Let me
 * see.", "One sec.") is injected as a token so the caller hears the agent
 * start speaking instead of dead air. The model's own tokens then follow
 * untouched; the filler simply becomes the first sentence of the turn.
 *
 * The wrapper also records when the model's real first token arrived so
 * the pipeline can keep `ttftMs` honest (the TTS stage would otherwise
 * see the filler as the first delta).
 */

import { monotonicClock, type Clock } from '../../shared/clock.js'
import type { DirectorStreamEvent } from '../../shared/streaming-types.js'

export interface LatencyFillerOptions {
	/** How long to wait for the model's first token before speaking a filler. */
	delayMs: number
	/** Picks the filler text for this turn; return '' to stay silent. */
	pick: (context: { transcript: string }) => string
	/** Called when a filler is spoken. */
	onInjected?: (filler: string) => void
}

export interface LatencyFillerStream {
	events: AsyncGenerator<DirectorStreamEvent, string>
	/** Clock time of the model's own first token, or null if none arrived yet. */
	modelFirstTokenAt: () => number | null
	/** Filler text spoken for this turn, or null. */
	injected: () => string | null
}

interface WrapOptions {
	delayMs: number
	filler: () => string
	signal?: AbortSignal
	clock?: Clock
	onInjected?: (filler: string) => void
}

function isToken(event: DirectorStreamEvent | undefined): boolean {
	return !!event && event.type === 'token' && typeof event.value === 'string' && event.value.trim().length > 0
}

export function withLatencyFiller(
	events: AsyncGenerator<DirectorStreamEvent, string>,
	options: WrapOptions,
): LatencyFillerStream {
	const clock = options.clock ?? monotonicClock
	let modelFirstTokenAt: number | null = null
	let injected: string | null = null

	async function* wrapped(): AsyncGenerator<DirectorStreamEvent, string> {
		let timer: NodeJS.Timeout | undefined
		let resolveLate: (() => void) | undefined
		const late = new Promise<'late'>((resolve) => {
			resolveLate = () => resolve('late')
			timer = setTimeout(resolveLate, options.delayMs)
		})
		const clearLate = () => {
			if (timer) clearTimeout(timer)
			timer = undefined
		}

		try {
			// Wait for the first *non-empty* token so an initial empty delta
			// doesn't count as the model having started.
			let pending = events.next()
			let first: IteratorResult<DirectorStreamEvent, string> | null = null
			let lateFired = false
			while (first === null) {
				const outcome = lateFired
					? { kind: 'result' as const, r: await pending }
					: await Promise.race([pending.then((r) => ({ kind: 'result' as const, r })), late])
				if (outcome === 'late') {
					lateFired = true
					if (options.signal?.aborted) continue
					const text = options.filler()
					if (!text) continue
					injected = text
					options.onInjected?.(text)
					yield { type: 'token', value: `${text} ` }
					continue
				}
				if (outcome.r.done || isToken(outcome.r.value)) {
					first = outcome.r
					break
				}
				// Empty delta — pass it along and keep waiting for real text.
				yield outcome.r.value
				pending = events.next()
			}
			clearLate()

			let result = first
			if (!result.done) modelFirstTokenAt = clock.now()
			while (!result.done) {
				yield result.value
				result = await events.next()
			}
			return result.value
		} finally {
			clearLate()
			// Settle the race promise so nothing dangles if we exit early.
			resolveLate?.()
		}
	}

	const generator = wrapped()
	const originalReturn = generator.return.bind(generator)
	// Propagate early termination (token readable destroy) to the inner stream.
	generator.return = async (value) => {
		try {
			await events.return(value as never)
		} catch {
			/* inner stream already closed */
		}
		return originalReturn(value)
	}

	return {
		events: generator,
		modelFirstTokenAt: () => modelFirstTokenAt,
		injected: () => injected,
	}
}

// ── Filler selection ─────────────────────────────────────────────────

/**
 * One neutral pool. Every filler commits the agent to nothing: it neither
 * agrees with a statement nor promises an answer to a question, so there
 * is no need to guess which the caller just produced.
 */
const fillers = ['Hmm.', 'Let me see.', 'One sec.'] as const

/** Creates a picker that varies the filler across turns and never repeats the previous one. */
export function createLatencyFillerPicker(random: () => number = Math.random): LatencyFillerOptions['pick'] {
	let previous = ''
	return () => {
		const pool = fillers.filter((f) => f !== previous)
		const choice = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] ?? ''
		previous = choice
		return choice
	}
}
