/**
 * Stream primitive types used across the outbound audio pipeline.
 *
 * The pipeline is built fresh for each turn and destroyed when the turn
 * exits. Long-lived resources (LiveKit AudioSource, TTS speaker,
 * transcriber) remain call-scoped and are wrapped in one-shot stream
 * adapters by the turn actor.
 */

import type { Writable } from 'node:stream'

/**
 * Per-turn handle into the transport layer. The underlying LiveKit
 * AudioSource is call-scoped; a fresh `AudioSink` is acquired for each
 * turn and released (destroyed) when the turn ends.
 */
export interface AudioSink extends Writable {
	/**
	 * Resolves once the transport has played out every frame that has
	 * been successfully accepted. Used as the gate between "all audio
	 * queued" and "caller heard it" in the turn lifecycle.
	 */
	waitForPlayout(): Promise<void>

	/**
	 * Discard any audio still queued inside the transport but not yet
	 * played. Called on interrupt, before any fade tail is written.
	 */
	clearQueue(): void

	/**
	 * Bypass the pipeline and write a single PCM buffer directly to the
	 * transport. Used for interrupt fade tails and backchannel clips
	 * that are not part of a turn pipeline.
	 */
	writeFrameDirect(chunk: Buffer): Promise<void>
}

/**
 * Snapshot of per-turn playback progress. Exposed by `PlaybackTracker`
 * so the interrupt path can estimate the "heard portion" of the draft.
 */
export interface PlaybackProgress {
	sentMs: number
	sentBytes: number
	confirmedWordsPlayed: number
	started: boolean
}

/**
 * Transport factory handed to the turn engine. Creates a fresh sink per
 * turn and exposes utilities that do not belong to any single turn
 * (backchannel playback, agent-speaking queries).
 */
export interface AudioTransport {
	createSink(): AudioSink
	playBackchannelFrame(chunk: Buffer): void
	/**
	 * True when the transport is still accepting new audio. False once
	 * the underlying AudioSource has been closed.
	 */
	isOpen(): boolean
	close(): Promise<void>
}
