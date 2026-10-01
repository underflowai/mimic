/**
 * Injectable monotonic clock.
 *
 * Every latency measurement in the engine (draft time, first-audio time,
 * barge timing, silence watchdogs) is a difference between two readings of
 * the same clock, so the clock only has to be monotonic — never an epoch.
 * Tests pass a fake to make timing deterministic.
 */

export interface Clock {
	/** Milliseconds since an arbitrary fixed origin. Monotonic. */
	now(): number
}

export const monotonicClock: Clock = {
	now: () => performance.now(),
}
