/**
 * Call-machine runtime wiring over CallMachine + TurnActor.
 *
 * Constructs the provided CallMachine with real action/actor implementations,
 * exposes a small public API the orchestrator (and legacy consumers) call
 * into. All state transitions, pipeline orchestration, commit, and interrupt
 * cleanup happen inside the machines — the engine just forwards events.
 *
 * ## Active turn handle
 *
 * While a turn is actively playing or preparing audio, the `run-turn-actor` registers an
 * `ActiveTurnHandle` with this runtime containing the live sink,
 * pause-gate, and playback tracker. Turn-actor actions (soft pause,
 * interrupt, fade) read from that handle to steer the pipeline
 * directly — there is no shared pauseState closure anymore.
 *
 * ## Outcome model
 *
 * The runtime is event-driven. Callers send events to `CallMachine` via
 * `sendToCallMachine(...)` and subscribe to `turn_outcome` emissions.
 */

import { Writable } from 'node:stream'
import type OpenAI from 'openai'
import { createActor, enqueueActions, fromCallback, fromPromise } from 'xstate'

import { createLogger } from '#engine/logger.js'
import * as telemetry from '#engine/telemetry.js'

import type { FluxConfigureOptions } from '../audio/deepgram-transcriber.js'
import { createPipeline } from '../audio/streams/pipeline.js'
import type { AudioSink, AudioTransport } from '../audio/streams/types.js'
import type { TtsSpeaker } from '../audio/tts-speaker.js'
import { eagerMachine, type EagerPreparedResult } from '../intelligence/eager-machine.js'
import { defaultMimicTools } from '../intelligence/tools/default-tools.js'
import { invocationMachine, type ExecuteToolInput } from '../intelligence/tools/invocation-machine.js'
import type { ToolDefinition } from '../intelligence/tools/runner.js'
import {
	getToolStateForControlBlock,
	toolSupervisor,
	type ToolSupervisorActor,
	type ToolSupervisorSnapshot,
} from '../intelligence/tools/supervisor-machine.js'
import { createToolTransport } from '../intelligence/tools/transport.js'
import type { TranscriptToolEvent } from '../intelligence/tools/types.js'
import { watchForToolAction } from '../intelligence/tools/watcher.js'
import type { BackgroundIntelligence, Director, EagerAudioSink } from '../intelligence/types.js'
import { isAbortLikeError } from '../shared/async-utils.js'
import type { Metrics, SoftPauseEvent, TurnOutcomeMetric } from '../shared/metrics.js'
import type { CallTurn } from '../shared/prompt-turns.js'
import type { ActiveTurnHandle } from './actors/run-turn-actor.js'
import {
	isAgentSpeaking as isAgentSpeakingSelector,
	shouldSuppressBackchannel as shouldSuppressBackchannelSelector,
} from './call-machine-selectors.js'
import { callMachine, getTurnActorSnapshot } from './call-machine.js'
import { runTurnActorLogic, turnActorMachine, type CommitActorDeps, type RunTurnActorDeps } from './turn-actor.js'
import type { InterruptReason } from './types.js'

const log = createLogger('mimic:turn')
export type { CommittedTurn, TurnOutcome } from './types.js'

export interface CallMachineRuntimeDeps {
	callSignal: AbortSignal
	tts: TtsSpeaker
	specTts: TtsSpeaker
	director: Director
	backgroundClient: OpenAI
	metrics: Metrics
	/**
	 * Lazy getter for the audio transport. Late-bound so the orchestrator
	 * can be constructed before the LiveKit voice agent attaches a
	 * transport. Throws if no transport has been bound by the time a turn
	 * starts.
	 */
	getAudioTransport: () => AudioTransport
	backgroundIntelligence: BackgroundIntelligence
	incrementTurn: () => void
	/** Configure the transcriber (currently used for keyterms/background updates). */
	configureTranscriber: (opts: FluxConfigureOptions) => void
	sanitize: (text: string) => string
	classifyPromotion: (
		specTranscript: string,
		finalTranscript: string,
		draftResponse: string | null,
		signal?: AbortSignal,
	) => Promise<boolean>
	buildControlBlock: (
		transcript: string,
		opts?: {
			silenceFollowUp?: boolean
			silenceClosing?: boolean
			silenceFollowUpCount?: number
			toolResult?: { topic: string; result: string } | null
			toolResults?: Array<{ topic: string; result: string }>
			hasActiveTools?: boolean
			pendingTools?: string[]
			executingTools?: string[]
		},
	) => string
	webSearcher: import('../intelligence/tools/web-searcher.js').WebSearcher
	getCallerDateTime: () => string | undefined
	getDirectorTurns: () => CallTurn[]
	tools?: import('../intelligence/tools/runner.js').ToolDefinition[]
	executeTool?: import('../intelligence/tools/transport.js').ToolExecutor
	onSilenceHangup: () => void
}

export function createCallMachineRuntime(deps: CallMachineRuntimeDeps) {
	const commitUserOnly = (_: unknown, params: { userTranscript: string }) => {
		deps.director.commitTurn({ kind: 'user_only', user: params.userTranscript })
	}

	// ------------------------------------------------------------------
	// Active turn handle — registered by run-turn-actor when a pipeline
	// starts, cleared when it tears down. Turn-actor actions read from
	// this to pause/clear/fade the live stream.
	// ------------------------------------------------------------------

	let activeTurn: ActiveTurnHandle | null = null
	let freshTurnHasSentFirstAudio = false

	function registerActiveTurn(handle: ActiveTurnHandle) {
		activeTurn = handle
		freshTurnHasSentFirstAudio = false
		handle.tracker.firstChunk
			.then(() => {
				freshTurnHasSentFirstAudio = true
			})
			.catch(() => {})
	}

	function clearActiveTurn(turnId: number, options: { destroySink?: boolean } = {}) {
		const handle = activeTurn
		if (handle?.turnId !== turnId) return
		activeTurn = null
		if (options.destroySink && !handle.sink.destroyed) handle.sink.destroy()
	}

	function getActiveTurnSnapshot() {
		const handle = activeTurn
		if (!handle) return { sentMs: 0, confirmedWordsPlayed: 0 }
		const snap = handle.tracker.snapshot()
		return { sentMs: snap.sentMs, confirmedWordsPlayed: snap.confirmedWordsPlayed }
	}

	function activeTurnLogFields() {
		const handle = activeTurn
		const playback = getActiveTurnSnapshot()
		return {
			activeTurnId: handle?.turnId ?? null,
			sentMs: playback.sentMs,
			confirmedWordsPlayed: playback.confirmedWordsPlayed,
		}
	}

	// ------------------------------------------------------------------
	// Eager + search child machines (provided before we construct CallMachine).
	// ------------------------------------------------------------------

	const eagerLog = createLogger('mimic:eager')

	function createEagerCaptureSink(sink: EagerAudioSink): AudioSink {
		const writable = new Writable({
			write(chunk, _encoding, callback) {
				if (sink.done) {
					callback()
					return
				}
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
				if (sink.forward) {
					sink.forward(buffer)
				} else {
					sink.chunks.push(buffer)
				}
				callback()
			},
		}) as AudioSink
		writable.waitForPlayout = async () => {}
		writable.clearQueue = () => {
			sink.chunks.length = 0
		}
		writable.writeFrameDirect = async (chunk) => {
			if (sink.done) return
			if (sink.forward) {
				sink.forward(chunk)
			} else {
				sink.chunks.push(chunk)
			}
		}
		return writable
	}

	const providedEagerMachine = eagerMachine.provide({
		actors: {
			eagerGeneration: fromPromise<
				EagerPreparedResult | null,
				{ transcript: string; controlBlock: string; signal: AbortSignal }
			>(async ({ input }) => {
				const tokenized = deps.director.streamDraftTokenized(input.transcript, input.controlBlock, input.signal)
				const sink: EagerAudioSink = { chunks: [], done: false, forward: null }
				const captureSink = createEagerCaptureSink(sink)
				const pipeline = createPipeline({
					tts: deps.specTts,
					sanitize: deps.sanitize,
					sink: captureSink,
					signal: input.signal,
					source: { kind: 'tokens', events: tokenized.events },
				})
				const agentResponsePromise = pipeline.agentResponseReady.then((response) => deps.sanitize(response))
				const ttsPromise = pipeline.completion
					.then((result) => {
						if (!result.audioSent && !input.signal.aborted) {
							eagerLog.info({ transcript: tokenized.userTranscript }, 'eager generation completed without audio')
						}
						sink.done = true
					})
					.catch((err) => {
						sink.done = true
						if (err instanceof DOMException && err.name === 'AbortError') return
						if (input.signal.aborted || isAbortLikeError(err)) return
						eagerLog.error({ err }, 'eager streaming synthesis failed')
					})
				sink.ttsPromise = ttsPromise
				const agentResponse = await agentResponsePromise.catch((err) => {
					if (!input.signal.aborted && !isAbortLikeError(err)) {
						eagerLog.error({ err }, 'eager streaming agent response failed')
					}
					return ''
				})
				if (input.signal.aborted || !agentResponse.trim()) return null

				return {
					agentResponse,
					userTranscript: tokenized.userTranscript,
					controlBlock: input.controlBlock,
					sink,
					triggerSynthesisStart: null,
					ttsPromise,
				}
			}),
			finalValidator: fromPromise(
				async ({
					input,
				}: {
					input: {
						basisTranscript: string
						finalTranscript: string
						draftResponse: string | null
						signal: AbortSignal
					}
				}) => {
					if (input.signal.aborted) return { valid: false }
					try {
						const valid = await deps.classifyPromotion(
							input.basisTranscript,
							input.finalTranscript,
							input.draftResponse,
							input.signal,
						)
						eagerLog.info(
							{
								valid,
								specPreview: input.basisTranscript.slice(0, 50),
								finalPreview: input.finalTranscript.slice(0, 50),
								hasDraft: input.draftResponse !== null,
							},
							'speculation final validation',
						)
						return { valid }
					} catch (err) {
						if (input.signal.aborted || isAbortLikeError(err)) return { valid: false }
						eagerLog.error({ err }, 'speculation validation failed, discarding')
						return { valid: false }
					}
				},
			),
		},
		actions: {
			abortCurrent: (_, params) => {
				try {
					params.abort.abort()
				} catch (err) {
					if (!isAbortLikeError(err)) eagerLog.error({ err }, 'abortCurrent threw unexpectedly')
				}
			},
			interruptSpecTts: () => deps.specTts.interrupt(),
		},
	})

	const toolTransport = createToolTransport({
		getCallerDateTime: deps.getCallerDateTime,
		tools: deps.tools ?? [],
		webSearcher: deps.webSearcher,
		executeTool: deps.executeTool,
	})
	const allTools: ToolDefinition[] = [
		...defaultMimicTools,
		...(deps.tools ?? []).map((tool) => {
			if (tool.kind !== 'read' && tool.kind !== 'write') {
				throw new Error(`Tool "${tool.name}" is missing required "kind" metadata (read|write)`)
			}
			return tool
		}),
	]

	// ------------------------------------------------------------------
	// Deps bundles passed to TurnActor via CallMachine input
	// ------------------------------------------------------------------

	const runTurnDeps: RunTurnActorDeps = {
		director: {
			streamDraftTokenized: (transcript: string, controlBlock: string, signal?: AbortSignal) =>
				deps.director.streamDraftTokenized(transcript, controlBlock, signal),
		},
		tts: deps.tts,
		getTransport: deps.getAudioTransport,
		sanitize: deps.sanitize,
		registerActiveTurn,
		clearActiveTurn,
	}

	const commitDeps: CommitActorDeps = {
		director: {
			commitTurn: (content) => deps.director.commitTurn(content),
		},
		incrementTurn: () => deps.incrementTurn(),
		metrics: { recordTurnTiming: (timing) => deps.metrics.recordTurnTiming(timing) },
	}

	// Flux can emit repeated eager boundaries for the same utterance
	// (e.g. punctuation-only transcript stabilization after TurnResumed).
	// Suppress near-duplicate eager triggers so we do not restart eager
	// generation unnecessarily.
	let lastEagerNormalized: string | null = null
	let lastFinalNormalized: string | null = null
	let transcriptEventLog: TranscriptToolEvent[] = []

	function appendTranscriptEvent(event: TranscriptToolEvent) {
		transcriptEventLog.push(event)
		if (transcriptEventLog.length > 80) {
			transcriptEventLog = transcriptEventLog.slice(-80)
		}
	}

	function mapCallEventToTranscriptEvent(event: { type: string; [key: string]: unknown }): TranscriptToolEvent | null {
		switch (event.type) {
			case 'caller_turn_start':
			case 'caller_update':
			case 'caller_eager_turn':
			case 'caller_turn_resumed':
			case 'caller_turn_complete': {
				const transcript = typeof event.transcript === 'string' ? event.transcript : ''
				const confidence = typeof event.confidence === 'number' ? event.confidence : undefined
				if (!transcript.trim()) return null
				return {
					type: event.type,
					transcript,
					confidence,
					recordedAtMs: Date.now(),
				}
			}
			default:
				return null
		}
	}

	function normalizeEagerTranscript(transcript: string) {
		return transcript
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
	}

	function isDuplicateEagerTranscript(transcript: string) {
		const normalized = normalizeEagerTranscript(transcript)
		if (!normalized) return true
		if (lastEagerNormalized === normalized) return true
		lastEagerNormalized = normalized
		return false
	}

	function isDuplicateFinalTranscript(transcript: string) {
		const normalized = normalizeEagerTranscript(transcript)
		if (!normalized) return true
		if (lastFinalNormalized === normalized) return true
		lastFinalNormalized = normalized
		return false
	}

	const providedToolSupervisor = toolSupervisor.provide({
		actors: {
			classifyAndExecute: fromCallback(({ input, sendBack }) => {
				const abortController = new AbortController()
				if (deps.callSignal.aborted) return
				deps.callSignal.addEventListener('abort', () => abortController.abort(), { once: true })
				watchForToolAction(deps.backgroundClient, {
					transcript: input.transcript,
					recentTurns: input.recentTurns,
					tools: allTools,
					priorToolResults: getCompletedToolResults(),
					existingToolName: input.existingToolName,
					existingToolArgs: input.existingToolArgs,
					signal: abortController.signal,
				})
					.then((decision) => {
						sendBack({
							type: 'CLASSIFY_RESULT',
							classifyId: input.classifyId,
							transcript: input.transcript,
							taskId: input.taskId,
							turnId: input.turnId,
							needsTool: decision.decision === 'execute' || decision.decision === 'not_ready',
							query: input.transcript.trim(),
							toolName: decision.tool,
							toolArgs: decision.args,
							missingArgs: decision.missing ?? [],
							directorNote: decision.directorNote,
						})
					})
					.catch(() => {
						sendBack({
							type: 'CLASSIFY_RESULT',
							classifyId: input.classifyId,
							transcript: input.transcript,
							taskId: input.taskId,
							turnId: input.turnId,
							needsTool: false,
							query: input.transcript.trim(),
							toolName: null,
							toolArgs: null,
							missingArgs: [],
							directorNote: null,
						})
					})
				return () => abortController.abort()
			}),
			toolInvocation: invocationMachine.provide({
				actors: {
					executeTool: fromPromise(async ({ input }: { input: ExecuteToolInput }) => {
						return toolTransport.execute({
							toolName: input.toolName,
							toolArgs: input.toolArgs,
							conversationTurns: input.conversationTurns,
							signal: input.signal,
						})
					}),
				},
			}),
		},
	})

	// ------------------------------------------------------------------
	// Provide CallMachine with concrete actions + TurnActor with deps
	// ------------------------------------------------------------------

	const providedTurnActorMachine = turnActorMachine.provide({
		actors: {
			runTurnPipeline: runTurnActorLogic,
		},
		actions: {
			onPlaybackComplete: () => {
				log.info('awaiting playout')
				const handle = activeTurn
				if (!handle) return
				handle.sink
					.waitForPlayout()
					.then(() => {
						actor.send({ type: 'playback_confirmed' })
					})
					.catch((err) => {
						log.error({ err }, 'waitForPlayout failed')
						actor.send({ type: 'playback_confirmed' })
					})
			},
			onSuspendAudio: () => {
				activeTurn?.pauseGate.pauseGate()
				log.info(activeTurnLogFields(), 'audio soft-paused')
			},
			clearBuffer: () => {
				const handle = activeTurn
				if (!handle) return
				log.info(activeTurnLogFields(), 'clearing active turn audio')
				handle.pauseGate.clearBuffered()
				handle.sink.clearQueue()
			},
			drainAudioFade: () => {
				const handle = activeTurn
				if (!handle) return
				const fadeFrames = handle.tracker.buildFadeTail()
				if (fadeFrames.length === 0) return
				log.info({ ...activeTurnLogFields(), fadeFrames: fadeFrames.length }, 'draining audio fade tail')
				for (const frame of fadeFrames) {
					void handle.sink.writeFrameDirect(frame)
				}
			},
			interruptTts: () => {
				log.info(activeTurnLogFields(), 'interrupting primary TTS')
				deps.tts.interrupt()
			},
			cancelEager: () => actor.send({ type: 'cancel_eager_from_turn' }),
			recordBarge: (_, params) => {
				const wordCount = params.draft ? params.draft.split(/\s+/).length : 0
				const sentMs = activeTurn?.tracker.snapshot().sentMs ?? 0
				log.info(
					{
						...activeTurnLogFields(),
						wordCount,
						agentResponse: params.draft,
					},
					'barge interrupt recorded',
				)
				deps.metrics.recordBarge({ outcome: 'interrupted', wordCount, elapsedMs: sentMs })
			},
			estimateHeardAndCommitPartial: (_, params) => {
				if (params.interruptContext.heardPortion) {
					log.info(
						{
							...activeTurnLogFields(),
							heardPortion: params.interruptContext.heardPortion,
							fullDraft: params.interruptContext.fullDraft,
						},
						'committing heard partial response',
					)
					deps.director.commitTurn({
						kind: 'partial_exchange',
						user: params.userTranscript || '[interrupted before caller spoke]',
						heardAgentPortion: params.interruptContext.heardPortion,
					})
				}
			},
			commitDraft: (_, params) => {
				deps.director.commitTurn({
					kind: 'exchange',
					user: params.userTranscript,
					agent: params.draftResponse,
				})
			},
			commitUserOnly,
			flushPausedBuffer: () => {
				activeTurn?.pauseGate.resumeGate()
			},
			recordSoftPauseMetrics: (_, params) => {
				const event: SoftPauseEvent = params
				deps.metrics.recordSoftPause(event)
			},
			onSubstantiveSpeechTimeout: (_, params) => {
				log.info('substantive speech timer fired, interrupting')
				if (params.vadSpeechStartAt > 0) {
					telemetry.metrics.distribution('mimic.interrupt.classification_ms', Date.now() - params.vadSpeechStartAt, {
						unit: 'millisecond',
					})
				}
			},
			recordShortResumedBarge: () => {
				log.info('VAD speech ended during soft-pause, resuming (caller stopped)')
				deps.metrics.recordBarge({ outcome: 'short_resumed', wordCount: 0, elapsedMs: 0 })
			},
			resetPauseState: () => {
				// Pipeline/pause-gate are per-turn; nothing to reset here.
			},
		},
	})

	const providedCallMachine = callMachine.provide({
		actors: {
			eagerPipeline: providedEagerMachine,
			turnActor: providedTurnActorMachine,
			toolPipeline: providedToolSupervisor,
		},
		guards: {
			hasFreshTurnSentAudio: () => freshTurnHasSentFirstAudio,
		},
		actions: {
			onEagerPromotionMetrics: (_, params) => {
				deps.metrics.recordSpeculation({
					outcome: params.outcome,
					speculativeTranscript: params.specTranscript,
					finalTranscript: params.finalTranscript,
					speculationDurationMs: params.durationMs,
				})
			},
			triggerEagerTurn: enqueueActions(({ enqueue }, params: unknown) => {
				const p = params as { transcript: string; confidence: number }
				if (isDuplicateEagerTranscript(p.transcript)) return
				lastFinalNormalized = null
				const turnId = allocateTurnId()
				const toolState = getToolState()
				const controlBlock = deps.buildControlBlock(p.transcript, toolState)
				enqueue.sendTo('eager-pipeline', {
					type: 'EAGER_TURN',
					transcript: p.transcript,
					controlBlock,
					turnId,
				})
			}),
			completeCallerTurn: enqueueActions(({ context, enqueue }, params: unknown) => {
				const p = params as { transcript: string; confidence: number }
				if (isDuplicateFinalTranscript(p.transcript)) return
				lastEagerNormalized = null
				const turnActorSnap = getTurnActorSnapshot(actor.getSnapshot())
				const agentLastResponse = turnActorSnap?.context?.draftResponse ?? ''
				const sCtx = getToolState()
				const controlBlock = deps.buildControlBlock(p.transcript, sCtx)
				enqueue.sendTo('tool-pipeline', {
					type: 'DETECT_INTENT',
					transcript: p.transcript,
					turnId: context.nextTurnId,
					recentTurns: deps.getDirectorTurns().slice(-10),
				})
				enqueue.raise({
					type: 'turn_complete',
					transcript: p.transcript,
					confidence: p.confidence,
					controlBlock,
					agentLastResponse,
				})
			}),
			markEagerTurnResumed: enqueueActions(({ enqueue }) => {
				enqueue.sendTo('eager-pipeline', { type: 'MARK_TURN_RESUMED' })
			}),
			cancelEager: enqueueActions(({ enqueue }) => {
				lastFinalNormalized = null
				enqueue.sendTo('eager-pipeline', { type: 'CANCEL' })
			}),
			commitUserOnly,
			recordTurnOutcomeMetric: (_, params) => {
				const outcome = params.outcome
				const metric: TurnOutcomeMetric =
					outcome.kind === 'committed'
						? 'committed'
						: outcome.kind === 'interrupted'
							? 'interrupted'
							: outcome.kind === 'deferred'
								? 'deferred'
								: 'discarded'
				deps.metrics.recordTurnOutcome(metric)
				if (outcome.kind === 'discarded' && outcome.reason === 'failed') {
					deps.metrics.incrementDiscarded()
				}
			},
			requestSilenceFollowUp: enqueueActions(({ context, enqueue }, params: unknown) => {
				const p = params as { silenceFollowUpCount: number; silenceClosing: boolean }
				if (isClosing()) return
				const toolState = getToolState()
				const controlBlock = deps.buildControlBlock('', {
					...toolState,
					silenceFollowUp: true,
					silenceClosing: p.silenceClosing,
					silenceFollowUpCount: p.silenceFollowUpCount,
				})
				log.info(
					{
						silenceFollowUpCount: p.silenceFollowUpCount,
						silenceClosing: p.silenceClosing,
					},
					'silence watchdog firing director follow-up',
				)
				enqueue.assign({
					pendingStrategy: () => ({
						strategy: { kind: 'fresh' as const, transcript: '', controlBlock },
						turnId: context.nextTurnId,
						userTranscript: '',
						generationStartedAt: Date.now(),
					}),
					pendingSilenceClosing: () => p.silenceClosing === true,
					nextTurnId: () => context.nextTurnId + 1,
				})
				enqueue.raise({ type: 'reset_idle' })
			}),
			requestCallHangup: (_, params: { source: 'silence' | 'end_call_tag' }) => {
				log.info({ source: params.source }, 'call hangup requested')
				deps.onSilenceHangup()
			},
			onTranscriberError: (_, params) => {
				log.warn({ message: params.message }, 'transcriber reported runtime error')
			},
			commitToolResultToDirector: (_, params) => {
				const { toolName, result } = params as { toolName: string; result: string }
				if (!toolName || !result) return
				const callId = `supervisor_${toolName}_${Date.now()}`
				deps.director.commitToolCall({ id: callId, name: toolName, args: {} })
				deps.director.commitToolResult(callId, result)
				log.info({ toolName, callId }, 'committed supervisor tool result to director history')
				const supSnapshot = getToolSupervisorSnapshot()
				if (supSnapshot) {
					const supActor = actor.getSnapshot().children['tool-pipeline'] as ToolSupervisorActor | undefined
					supActor?.send({ type: 'CLEAR_CONSUMED_RESULTS' })
				}
			},
		},
	})

	const getAudioSenderSnapshot = () => getActiveTurnSnapshot()

	const actor = createActor(providedCallMachine, { input: { runTurnDeps, commitDeps, getAudioSenderSnapshot } }).start()

	actor.on('turn_outcome', ({ outcome }) => {
		clearActiveTurn(outcome.turnId, { destroySink: true })
	})

	// ------------------------------------------------------------------
	// Snapshot helpers
	// ------------------------------------------------------------------

	function getToolState() {
		const snapshot = getToolSupervisorSnapshot()
		if (!snapshot)
			return {
				pendingTools: [],
				executingTools: [],
				toolResults: [],
				toolDefinitions: allTools.map((t) => ({ name: t.name, description: t.description })),
			}
		return getToolStateForControlBlock(snapshot)
	}

	function getToolSupervisorSnapshot(): ToolSupervisorSnapshot | null {
		try {
			const snapshot = actor.getSnapshot()
			return (snapshot.children['tool-pipeline'] as ToolSupervisorActor)?.getSnapshot() ?? null
		} catch {
			return null
		}
	}

	function getCompletedToolResults(): Array<{ toolName: string; result: string }> {
		const snapshot = getToolSupervisorSnapshot()
		if (!snapshot) return []
		return snapshot.context.completedResults.map((r) => ({ toolName: r.toolName, result: r.result }))
	}

	function getContext() {
		return actor.getSnapshot().context
	}

	function isClosing() {
		return getContext().isClosing
	}

	function allocateTurnId() {
		const current = getContext().nextTurnId
		actor.send({ type: 'allocate_turn_id' })
		return current
	}

	// ------------------------------------------------------------------
	// Caller-facing actions
	// ------------------------------------------------------------------

	function sendToCallMachine(event: { type: string; [key: string]: unknown }) {
		const transcriptEvent = mapCallEventToTranscriptEvent(event)
		if (transcriptEvent) appendTranscriptEvent(transcriptEvent)
		actor.send(event as never)
	}

	function handlePlaybackConfirmed() {
		actor.send({ type: 'playback_confirmed' })
	}

	// ------------------------------------------------------------------
	// Interrupt
	// ------------------------------------------------------------------

	function interruptActiveTurn(reason: InterruptReason) {
		const snapshot = actor.getSnapshot()
		if (snapshot.matches('idle') || snapshot.matches('interrupted')) return
		log.info({ reason, state: String(snapshot.value) }, 'interrupted')
		actor.send({ type: 'interrupt', reason })
	}

	// ------------------------------------------------------------------
	// Public API
	// ------------------------------------------------------------------

	return {
		actor,
		sendToCallMachine,
		/** Manually inject playback_confirmed. Mostly for tests. */
		handlePlaybackConfirmed,
		interruptActiveTurn,
		isAgentStreaming() {
			return isAgentSpeakingSelector(actor.getSnapshot())
		},
		shouldSuppressBackchannel() {
			return shouldSuppressBackchannelSelector(actor.getSnapshot())
		},
		markClosing() {
			actor.send({ type: 'close' })
		},
		resetToolTasks() {
			const toolActor = actor.getSnapshot().children['tool-pipeline'] as ToolSupervisorActor | undefined
			toolActor?.send({ type: 'RESET' })
			transcriptEventLog = []
		},
		stop() {
			const toolActor = actor.getSnapshot().children['tool-pipeline'] as ToolSupervisorActor | undefined
			toolActor?.send({ type: 'RESET' })
			actor.stop()
		},
	}
}

export type CallMachineRuntime = ReturnType<typeof createCallMachineRuntime>

// Re-export for tests / legacy consumers
export {
	getEagerChildSnapshot,
	getToolPipelineSnapshot,
	getTurnActorSnapshot,
	type CallMachineSnapshot,
} from './call-machine.js'
