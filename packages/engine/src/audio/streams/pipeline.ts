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

import { Readable, type Stream } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { createFrameAlignTransform } from './frame-align.js'
import { createPauseGate, type PauseGate } from './pause-gate.js'
import { createPlaybackTracker, type PlaybackTracker } from './playback-tracker.js'
import { createSentenceChunkerTransform } from './sentence-chunker.js'
import { createPresynthPcmReadable, createTokenReadable } from './sources.js'
import { createTtsSynthesisTransform } from './tts-synthesis.js'
import type { AudioSink } from './types.js'

import type { DirectorStreamEvent, EagerAudioSink } from '../../shared/streaming-types.js'
import { extractTtsControlTags } from '../tts-sanitizer.js'
import type { TtsSpeaker } from '../tts-speaker.js'

export type PipelineSource =
	| {
			kind: 'tokens'
			events: AsyncGenerator<DirectorStreamEvent, string>
	  }
	| {
			kind: 'presynth'
			sink: EagerAudioSink
			ttsPromise: Promise<void> | null
			agentResponse: string
			endCallRequested?: boolean
			triggerSynthesisStart?: (() => void) | null
	  }

export interface PipelineDeps {
	tts: TtsSpeaker
	sanitize: (text: string) => string
	sink: AudioSink
	signal: AbortSignal
	source: PipelineSource
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
}

export function createPipeline(deps: PipelineDeps): PipelineHandle {
	const pauseGate = createPauseGate()
	const tracker = createPlaybackTracker()
	const frameAlign = createFrameAlignTransform()

	let agentResponseOnResolve!: (value: string) => void
	const agentResponsePromise = new Promise<string>((resolve) => {
		agentResponseOnResolve = resolve
	})

	const generationStartedAt = Date.now()
	let firstAudioAt: number | null = null
	let ttsSendAt: number | null = null
	let ttsFirstByteAt: number | null = null
	let firstTokenAt: number | null = null
	let llmCompleteAt: number | null = null
	let endCallRequested = false

	const stages: Stream[] = []
	let source: Readable
	let ttsHandle: ReturnType<typeof createTtsSynthesisTransform> | null = null

	switch (deps.source.kind) {
		case 'tokens': {
			const token = createTokenReadable(deps.source.events, deps.signal)
			source = token.stream
			token.finalResponse.then(
				(value) => {
					llmCompleteAt = Date.now()
					const extracted = extractTtsControlTags(value)
					endCallRequested = endCallRequested || extracted.endCallRequested
					agentResponseOnResolve(deps.sanitize(extracted.text))
				},
				() => {
					llmCompleteAt = Date.now()
					agentResponseOnResolve('')
				},
			)
			const chunker = createSentenceChunkerTransform()
			ttsHandle = createTtsSynthesisTransform({
				tts: deps.tts,
				sanitize: deps.sanitize,
				signal: deps.signal,
			})
			stages.push(source, chunker, ttsHandle.transform, frameAlign, pauseGate, tracker, deps.sink)
			break
		}
		case 'presynth': {
			const presynth = deps.source
			source = createPresynthPcmReadable(presynth.sink, presynth.ttsPromise)
			presynth.triggerSynthesisStart?.()
			const extracted = extractTtsControlTags(presynth.agentResponse)
			endCallRequested = presynth.endCallRequested === true || extracted.endCallRequested
			agentResponseOnResolve(deps.sanitize(extracted.text))
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
			// @ts-expect-error variadic pipeline typings do not accept a Stream[] directly
			await pipeline(...stages, { signal: deps.signal })
		} catch (err) {
			if (!deps.signal.aborted) throw err
		}

		if (ttsHandle) {
			ttsSendAt = ttsHandle.ttsSendAt()
			ttsFirstByteAt = ttsHandle.ttsFirstByteAt()
			firstTokenAt = ttsHandle.firstTokenAt()
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
		}
	})()

	return {
		tracker,
		pauseGate,
		agentResponseReady: agentResponsePromise,
		completion,
		endCallRequested: () => endCallRequested,
	}
}
