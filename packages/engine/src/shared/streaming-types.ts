import type { WordTiming } from './audio-pacing.js'

export type DirectorStreamEvent = { type: 'token'; value: string }

/**
 * Buffer that an eager (speculative) turn synthesizes into before we know
 * whether it will be played. Promotion hands it to the presynth pipeline
 * source, which replays `chunks` and then follows `forward`.
 */
export interface EagerAudioSink {
	chunks: Buffer[]
	/** Word timings for the synthesized audio so far. Live array shared with the synthesis stage. */
	words: readonly WordTiming[]
	done: boolean
	forward: ((chunk: Buffer) => void) | null
	ttsPromise?: Promise<void>
}
