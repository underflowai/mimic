/**
 * Turn-scoped pipeline builder.
 *
 * Constructs a single `node:stream/promises` pipeline that carries
 * audio from the chosen source (LLM tokens / presynth
 * PCM) through TTS synthesis (optional), frame alignment, the
 * soft-pause gate, playback tracker, and finally the LiveKit sink.
 *
 * The pipeline is one-shot: a fresh instance is built for every turn
 * and every stream is destroyed when the pipeline ends or the caller
 * aborts. Long-lived resources (TTS speaker, LiveKit AudioSource) are
 * passed in and remain call-scoped.
 */

import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { WordTiming } from '../../shared/audio-pacing.js'
import { monotonicClock, type Clock } from '../../shared/clock.js'
import type { DirectorStreamEvent, EagerAudioSink } from '../../shared/streaming-types.js'
import { extractTtsControlTags } from '../tts-sanitizer.js'
import type { TtsSpeaker } from '../tts-speaker.js'
import { createFrameAlignTransform } from './frame-align.js'
import { withLatencyFiller } from './latency-filler.js'
import { createPauseGate, type PauseGate } from './pause-gate.js'
import { createPlaybackTracker, type PlaybackTracker } from './playback-tracker.js'
import { createSentenceChunkerTransform } from './sentence-chunker.js'
import { createPresynthPcmReadable, createTokenReadable } from './sources.js'
import { createTtsSynthesisTransform } from './tts-synthesis.js'
import type { AudioSink } from './types.js'

export type PipelineSource =
	| {
			kind: 'tokens'
			events: AsyncGenerator<DirectorStreamEvent, string>
			/** Speak a short filler if the model's first token is late. */
			latencyFiller?: { delayMs: number; filler: () => string; onInjected?: (filler: string) => void }
	  }
	| {
			kind: 'presynth'
			sink: EagerAudioSink
			ttsPromise: Promise<void> | null
			agentResponse: string
			endCallRequested?: boolean
			holdRequested?: boolean
			triggerSynthesisStart?: (() => void) | null
	  }

export interface PipelineDeps {
	tts: TtsSpeaker
	sanitize: (text: string) => string
	sink: AudioSink
	signal: AbortSignal
	source: PipelineSource
	clock?: Clock
	/** Called when the first PCM byte has reached the tracker. */
	onFirstAudio?: (at: number) => void
}

export interface PipelineResult {
	/** Full trimmed assistant response when known (empty on abort / empty output). */
	agentResponse: string
	firstAudioAt: number | null
	ttsFirstByteMs: number | null
	ttftMs: number | null
	ttcMs: number | null
	audioSent: boolean
	endCallRequested: boolean
	holdRequested: boolean
}

export interface PipelineHandle {
	tracker: PlaybackTracker
	pauseGate: PauseGate
	/**
	 * Resolves with the full agent response text as soon as it is known
	 * — immediately for presynth sources, and once the token
	 * stream drains for token sources. The turn actor uses this to
	 * emit `agent_text_finalized` (the "we know the complete response text"
	 * milestone).
	 */
	agentResponseReady: Promise<string>
	/** Awaited by the turn actor; resolves when all audio has been queued. */
	completion: Promise<PipelineResult>
	endCallRequested: () => boolean
	holdRequested: () => boolean
	/** Word timings for this turn's audio so far (live). */
	wordTimeline: () => readonly WordTiming[]
}

export function createPipeline(deps: PipelineDeps): PipelineHandle {
	const clock = deps.clock ?? monotonicClock
	const pauseGate = createPauseGate()
	const tracker = createPlaybackTracker(clock)
	const frameAlign = createFrameAlignTransform()

	let agentResponseOnResolve!: (value: string) => void
	const agentResponsePromise = new Promise<string>((resolve) => {
		agentResponseOnResolve = resolve
	})

	const generationStartedAt = clock.now()
	let firstAudioAt: number | null = null
	let ttsSendAt: number | null = null
	let ttsFirstByteAt: number | null = null
	let firstTokenAt: number | null = null
	let llmCompleteAt: number | null = null
	let endCallRequested = false
	let holdRequested = false

	const stages: Array<NodeJS.ReadableStream | NodeJS.ReadWriteStream | NodeJS.WritableStream> = []
	let source: Readable
	let ttsHandle: ReturnType<typeof createTtsSynthesisTransform> | null = null
	let wordTimeline: () => readonly WordTiming[]

	let modelFirstTokenAt: (() => number | null) | null = null

	switch (deps.source.kind) {
		case 'tokens': {
			let events = deps.source.events
			if (deps.source.latencyFiller) {
				const filler = withLatencyFiller(events, { ...deps.source.latencyFiller, signal: deps.signal, clock })
				events = filler.events
				modelFirstTokenAt = filler.modelFirstTokenAt
			}
			const token = createTokenReadable(events, deps.signal)
			source = token.stream
			token.finalResponse.then(
				(value) => {
					llmCompleteAt = clock.now()
					const extracted = extractTtsControlTags(value)
					endCallRequested = endCallRequested || extracted.endCallRequested
					holdRequested = holdRequested || extracted.holdRequested
					agentResponseOnResolve(deps.sanitize(extracted.text))
				},
				() => {
					llmCompleteAt = clock.now()
					agentResponseOnResolve('')
				},
			)
			const chunker = createSentenceChunkerTransform()
			const synthesis = createTtsSynthesisTransform({
				tts: deps.tts,
				sanitize: deps.sanitize,
				signal: deps.signal,
				clock,
			})
			ttsHandle = synthesis
			wordTimeline = synthesis.wordTimeline
			stages.push(source, chunker, synthesis.transform, frameAlign, pauseGate, tracker, deps.sink)
			break
		}
		case 'presynth': {
			const presynth = deps.source
			source = createPresynthPcmReadable(presynth.sink, presynth.ttsPromise)
			presynth.triggerSynthesisStart?.()
			const extracted = extractTtsControlTags(presynth.agentResponse)
			endCallRequested = presynth.endCallRequested === true || extracted.endCallRequested
			holdRequested = presynth.holdRequested === true || extracted.holdRequested
			agentResponseOnResolve(deps.sanitize(extracted.text))
			wordTimeline = () => presynth.sink.words
			stages.push(source, frameAlign, pauseGate, tracker, deps.sink)
			break
		}
	}

	if (ttsHandle) {
		ttsHandle.firstAudio
			.then((at) => {
				ttsFirstByteAt = at
			})
			.catch(() => {
				/* no audio emitted */
			})
	}

	tracker.firstChunk
		.then((at) => {
			firstAudioAt = at
			deps.onFirstAudio?.(at)
		})
		.catch(() => {
			/* no audio flowed */
		})

	const completion = (async (): Promise<PipelineResult> => {
		try {
			await pipeline(stages, { signal: deps.signal })
		} catch (err) {
			if (!deps.signal.aborted) throw err
		}

		if (ttsHandle) {
			ttsSendAt = ttsHandle.ttsSendAt()
			ttsFirstByteAt = ttsHandle.ttsFirstByteAt()
			// With a latency filler the TTS stage's first delta is the filler;
			// report the model's own first token so TTFT stays meaningful.
			firstTokenAt = modelFirstTokenAt ? modelFirstTokenAt() : ttsHandle.firstTokenAt()
		}

		const resolvedAgentResponse = await agentResponsePromise
		const agentResponse = ttsHandle?.textSent() || resolvedAgentResponse
		const snapshot = tracker.snapshot()
		return {
			agentResponse,
			firstAudioAt,
			ttsFirstByteMs: ttsSendAt && ttsFirstByteAt ? ttsFirstByteAt - ttsSendAt : null,
			ttftMs: firstTokenAt ? firstTokenAt - generationStartedAt : null,
			ttcMs: llmCompleteAt ? llmCompleteAt - generationStartedAt : null,
			audioSent: snapshot.started,
			endCallRequested,
			holdRequested,
		}
	})()

	return {
		tracker,
		pauseGate,
		agentResponseReady: agentResponsePromise,
		completion,
		endCallRequested: () => endCallRequested,
		holdRequested: () => holdRequested,
		wordTimeline: () => wordTimeline(),
	}
}
