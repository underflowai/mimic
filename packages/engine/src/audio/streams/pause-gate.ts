/**
 * Pause-gate transform.
 *
 * Implements the soft-pause behaviour previously handled by the shared
 * `pauseState` closure in `call-machine-runtime`. When paused, incoming
 * PCM chunks accumulate in an internal queue but are not forwarded. On
 * resume the queued chunks are flushed downstream in the order they
 * arrived; on clear they are dropped. The in-flight frames already
 * accepted by the transport continue playing out naturally (~100-200ms
 * tail), matching the previous behaviour.
 */

import { Transform, type TransformCallback } from 'node:stream'

export interface PauseGate extends Transform {
	/** Start buffering upstream chunks; stop forwarding downstream. */
	pauseGate(): void
	/** Flush any buffered chunks downstream and resume direct forwarding. */
	resumeGate(): void
	/** Drop any buffered chunks without flushing. */
	clearBuffered(): void
	/** True while the gate is buffering. */
	isPaused(): boolean
}

export function createPauseGate(): PauseGate {
	let paused = false
	let queue: Buffer[] = []

	const transform = new Transform({
		writableObjectMode: false,
		readableObjectMode: false,
		transform(chunk: Buffer, _encoding, callback: TransformCallback) {
			if (!Buffer.isBuffer(chunk)) {
				callback(new TypeError('pause-gate expected Buffer chunks'))
				return
			}
			if (paused) {
				queue.push(chunk)
				callback()
				return
			}
			callback(null, chunk)
		},
		flush(callback: TransformCallback) {
			if (queue.length === 0) {
				callback()
				return
			}
			for (const buffered of queue) this.push(buffered)
			queue = []
			callback()
		},
	})

	const gate = transform as PauseGate
	gate.pauseGate = () => {
		paused = true
	}
	gate.resumeGate = () => {
		if (!paused) return
		paused = false
		const pending = queue
		queue = []
		for (const chunk of pending) gate.push(chunk)
	}
	gate.clearBuffered = () => {
		queue = []
	}
	gate.isPaused = () => paused

	return gate
}
