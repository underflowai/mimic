/**
 * Run Turn Actor — builds and runs the per-turn audio pipeline.
 *
 * A fromCallback actor invoked by TurnActor's `executing` state.
 * Constructs a fresh `node:stream` pipeline for the strategy:
 *
 *   - fresh / first_turn: director tokens →
 *       TTS transform → frame align → pause gate → tracker → sink
 *   - presynthesized: buffered eager PCM → frame align → …
 *
 * Sends back events to TurnActor:
 *   - `agent_text_finalized { agentResponse }` — full response text is known
 *     (immediate for presynth, after LLM drain for tokens)
 *   - `first_audio_sent { at }` — first PCM reached the playback tracker
 *   - `stream_done { result }` — pipeline finished successfully
 *   - `stream_empty` — pipeline completed without audio
 *   - `stream_error { error }` — pipeline failed
 *
 * The actor registers an `ActiveTurnHandle` with the runtime so that
 * state-machine actions (soft pause, interrupt, fade) can reach into
 * the live pipeline. The handle is cleared when the actor stops.
 */

import { fromCallback } from 'xstate'

import { createLogger } from '#engine/logger.js'

import type { PauseGate } from '../../audio/streams/pause-gate.js'
import { createPipeline, type PipelineResult, type PipelineSource } from '../../audio/streams/pipeline.js'
import type { PlaybackTracker } from '../../audio/streams/playback-tracker.js'
import type { AudioSink, AudioTransport } from '../../audio/streams/types.js'
import type { TtsSpeaker } from '../../audio/tts-speaker.js'
import type { Director } from '../../intelligence/director.js'
import { isAbortLikeError } from '../../shared/async-utils.js'
import type { TurnStrategy } from '../strategy.js'

const log = createLogger('mimic:pipeline')

export type RunTurnStrategyInput = Extract<TurnStrategy, { kind: 'presynthesized' | 'fresh' | 'first_turn' }>

export interface StreamResult {
	agentResponse: string
	draftMs: number
	firstAudioAt: number | null
	ttsFirstByteMs: number | null
	ttftMs: number | null
	ttcMs: number | null
	audioSent: boolean
	endCallRequested: boolean
}

export interface ActiveTurnHandle {
	turnId: number
	sink: AudioSink
	tracker: PlaybackTracker
	pauseGate: PauseGate
}

export interface RunTurnActorDeps {
	director: Pick<Director, 'streamDraftTokenized'>
	tts: TtsSpeaker
	/** Late-bound transport getter; called when each turn begins. */
	getTransport: () => AudioTransport
	sanitize: (text: string) => string
	/** Called once the pipeline's sink + tracker are ready. */
	registerActiveTurn: (handle: ActiveTurnHandle) => void
	/** Called when the pipeline tears down (normal or aborted). */
	clearActiveTurn: (turnId: number) => void
}

export interface RunTurnActorInput {
	strategy: RunTurnStrategyInput
	turnId: number
	signal: AbortSignal
	generationAbort: AbortController
	generationStartedAt: number
	deps: RunTurnActorDeps
}

export type RunTurnActorEvent =
	| { type: 'audio_started'; agentResponse: string; endCallRequested?: boolean }
	| { type: 'first_audio_sent'; at: number }
	| { type: 'stream_done'; result: StreamResult }
	| { type: 'stream_empty'; userTranscript: string }
	| { type: 'stream_error'; error: unknown }

export const runTurnActorLogic = fromCallback<RunTurnActorEvent, RunTurnActorInput>(({ input, sendBack }) => {
	const { strategy, turnId, signal, generationAbort, generationStartedAt, deps } = input
	let canceled = false

	function buildSource(): { source: PipelineSource; userTranscript: string; initialResponse: string } {
		switch (strategy.kind) {
			case 'presynthesized':
				return {
					source: {
						kind: 'presynth',
						sink: strategy.sink,
						ttsPromise: strategy.ttsPromise,
						agentResponse: strategy.agentResponse,
						triggerSynthesisStart: strategy.triggerSynthesisStart,
					},
					userTranscript: strategy.transcript,
					initialResponse: strategy.agentResponse,
				}
			case 'fresh':
			case 'first_turn': {
				const transcript = 'transcript' in strategy ? strategy.transcript : ''
				const controlBlock = 'controlBlock' in strategy ? strategy.controlBlock : ''
				const openingBlock = 'openingBlock' in strategy ? strategy.openingBlock : ''
				const block = controlBlock || openingBlock
				const effectiveTranscript = transcript || (strategy.kind === 'first_turn' ? '[call connected]' : '')
				const streamResult = deps.director.streamDraftTokenized(effectiveTranscript, block, generationAbort.signal)
				return {
					source: { kind: 'tokens', events: streamResult.events },
					userTranscript: transcript,
					initialResponse: '',
				}
			}
		}
	}

	const { source, userTranscript, initialResponse } = buildSource()

	const transport = deps.getTransport()
	if (!transport.isOpen()) {
		sendBack({ type: 'stream_error', error: new Error('audio transport closed') })
		return
	}

	const sink = transport.createSink()
	let agentResponseEmitted = false
	let pipelineResult: PipelineResult | null = null

	const handle = createPipeline({
		tts: deps.tts,
		sanitize: deps.sanitize,
		sink,
		signal,
		source,
		onFirstAudio: (at) => sendBack({ type: 'first_audio_sent', at }),
	})

	deps.registerActiveTurn({ turnId, sink, tracker: handle.tracker, pauseGate: handle.pauseGate })

	// Emit `audio_started` the moment the agent response text is known.
	// For cached / presynth sources that is immediate; for token sources
	// it is when the LLM stream has fully drained (before TTS playout).
	if (initialResponse) {
		agentResponseEmitted = true
		sendBack({ type: 'audio_started', agentResponse: initialResponse, endCallRequested: handle.endCallRequested() })
	} else {
		handle.agentResponseReady
			.then((response) => {
				if (agentResponseEmitted || canceled) return
				if (!response) return
				agentResponseEmitted = true
				sendBack({ type: 'audio_started', agentResponse: response, endCallRequested: handle.endCallRequested() })
			})
			.catch(() => {
				/* pipeline failure handled separately */
			})
	}

	handle.completion
		.then((result) => {
			pipelineResult = result
			if (!agentResponseEmitted && result.agentResponse) {
				agentResponseEmitted = true
				sendBack({
					type: 'audio_started',
					agentResponse: result.agentResponse,
					endCallRequested: result.endCallRequested,
				})
			}
			if (canceled) return
			if (!result.audioSent) {
				sendBack({ type: 'stream_empty', userTranscript })
				return
			}
			sendBack({
				type: 'stream_done',
				result: {
					agentResponse: result.agentResponse,
					draftMs: Date.now() - generationStartedAt,
					firstAudioAt: result.firstAudioAt,
					ttsFirstByteMs: result.ttsFirstByteMs,
					ttftMs: result.ttftMs,
					ttcMs: result.ttcMs,
					audioSent: result.audioSent,
					endCallRequested: result.endCallRequested,
				},
			})
		})
		.catch((err) => {
			if (canceled || signal.aborted || isAbortLikeError(err)) return
			log.error({ turnId, err }, 'pipeline failed')
			sendBack({ type: 'stream_error', error: err })
		})
		.finally(() => {
			if (!pipelineResult?.audioSent) {
				deps.clearActiveTurn(turnId)
				if (!sink.destroyed) sink.destroy()
			}
		})

	return () => {
		canceled = true
		if (!pipelineResult?.audioSent) {
			if (!sink.destroyed) {
				sink.clearQueue()
				sink.destroy()
			}
			deps.clearActiveTurn(turnId)
		}
	}
})
