/**
 * Call-machine runtime wiring over CallMachine + TurnActor.
 *
 * Constructs the provided CallMachine with real action/actor implementations,
 * exposes a small public API the orchestrator calls
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
import { eagerMachine, type EagerMachineActor, type EagerPreparedResult } from '../intelligence/eager-machine.js'
import { defaultMimicTools } from '../intelligence/tools/default-tools.js'
import { invocationMachine, type ExecuteToolInput } from '../intelligence/tools/invocation-machine.js'
import type { ToolDefinition } from '../intelligence/tools/runner.js'
import {
	getToolStateForControlBlock,
	toolSupervisor,
	type ToolSupervisorActor,
	type ToolSupervisorSnapshot,
} from '../intelligence/tools/supervisor-machine.js'
import { validateToolArgs } from '../intelligence/tools/schema-validate.js'
import { createToolTransport, type ToolTransportResult } from '../intelligence/tools/transport.js'
import type { TranscriptToolEvent } from '../intelligence/tools/types.js'
import { watchForToolAction } from '../intelligence/tools/watcher.js'
import { buildWriteGateSources, checkWriteArgs } from '../intelligence/tools/write-gate.js'
import type { BackgroundIntelligence, Director, EagerAudioSink } from '../intelligence/types.js'
import { isAbortLikeError } from '../shared/async-utils.js'
import type { Metrics, SoftPauseEvent, TurnOutcomeMetric } from '../shared/metrics.js'
import type { CallTurn } from '../shared/prompt-turns.js'
import type { ActiveTurnHandle } from './actors/run-turn-actor.js'
import {
	isAgentSpeaking as isAgentSpeakingSelector,
	shouldSuppressBackchannel as shouldSuppressBackchannelSelector,
} from './call-machine-selectors.js'
import { callMachine, getEagerChildSnapshot, getTurnActorSnapshot } from './call-machine.js'
import { createConversationPhysics } from './conversation-physics.js'
import { createEarlyCommitController, normalizeTranscript, type EarlyCommitWorld } from './early-commit.js'
import type { PreparedGreeting } from './strategy.js'
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
	/** Fired when the call should end (silence watchdog exhausted, or the agent emitted `[end-call]`). */
	onHangupRequest: (source: 'silence' | 'end_call_tag') => void
	/** Append an entry to the per-call event log (replay/counterfactual substrate). */
	recordEvent?: (type: string, data?: Record<string, unknown>) => void
	/** Structured-data fields that require read-back verification before any WRITE tool (from the AgentSpec). */
	mustVerify?: string[]
	/** Observer for the tool audit trail: proposed → gate → executed. */
	onToolEvent?: (event: import('../intelligence/tools/types.js').ToolAuditEvent) => void
}

export function createCallMachineRuntime(deps: CallMachineRuntimeDeps) {
	const recordEvent = deps.recordEvent ?? (() => {})
	const onToolEvent = deps.onToolEvent ?? (() => {})

	const commitUserOnly = (_: unknown, params: { userTranscript: string }) => {
		deps.director.commitTurn({ kind: 'user_only', user: params.userTranscript })
	}

	// ------------------------------------------------------------------
	// Adaptive conversation physics — per-caller timing controller
	// ------------------------------------------------------------------

	const physics = createConversationPhysics({
		configureTranscriber: (opts) => deps.configureTranscriber(opts),
		onActivate: (evidence) => {
			log.info(evidence, 'slow-caller physics engaged — widening turn-taking timers')
			telemetry.metrics.count('mimic.physics.slow_caller_latched')
			recordEvent('physics_latched', { ...evidence })
		},
	})

	/** Control blocks pick up the physics line the moment the latch fires. */
	function buildControlBlock(...args: Parameters<CallMachineRuntimeDeps['buildControlBlock']>) {
		const block = deps.buildControlBlock(...args)
		const line = physics.getTunables().controlBlockLine
		if (!line) return block
		return block ? `${block}\n${line}` : line
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
				recordEvent('agent_first_audio', { turnId: handle.turnId })
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
					endCallRequested: pipeline.endCallRequested(),
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

	/**
	 * Pre-synthesized greeting — generate the opening line during call setup
	 * (SIP dial / ringing) through the speculative TTS session, capturing PCM
	 * into a buffer. The first turn flushes it the moment the caller picks
	 * up, instead of paying LLM + TTS latency after the pickup.
	 *
	 * Resolves when the greeting *text* is complete (audio may still be
	 * streaming into the sink — the presynth source live-forwards the rest).
	 * Resolves null on any failure; the first turn then generates fresh.
	 */
	async function prepareGreeting(openingBlock: string): Promise<PreparedGreeting | null> {
		const startedAt = Date.now()
		try {
			const abort = new AbortController()
			if (deps.callSignal.aborted) return null
			deps.callSignal.addEventListener('abort', () => abort.abort(), { once: true })

			const tokenized = deps.director.streamDraftTokenized('[call connected]', openingBlock, abort.signal)
			const sink: EagerAudioSink = { chunks: [], done: false, forward: null }
			const captureSink = createEagerCaptureSink(sink)
			const pipeline = createPipeline({
				tts: deps.specTts,
				sanitize: deps.sanitize,
				sink: captureSink,
				signal: abort.signal,
				source: { kind: 'tokens', events: tokenized.events },
			})
			const ttsPromise = pipeline.completion
				.then(() => {
					sink.done = true
				})
				.catch((err) => {
					sink.done = true
					if (!abort.signal.aborted && !isAbortLikeError(err)) {
						log.error({ err }, 'greeting pre-synthesis failed')
					}
				})
			sink.ttsPromise = ttsPromise

			const agentResponse = deps.sanitize(await pipeline.agentResponseReady)
			if (abort.signal.aborted || !agentResponse.trim()) return null

			log.info({ elapsedMs: Date.now() - startedAt, agentResponse }, 'greeting pre-synthesized during call setup')
			telemetry.metrics.count('mimic.greeting.presynthesized')
			recordEvent('greeting_prepared', { elapsedMs: Date.now() - startedAt, agentResponse })
			return { agentResponse, sink, ttsPromise, endCallRequested: pipeline.endCallRequested() }
		} catch (err) {
			if (!isAbortLikeError(err)) log.warn({ err }, 'greeting pre-synthesis failed; first turn will generate fresh')
			return null
		}
	}

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

	/**
	 * Verified-actions execution wrapper. Runs before any tool touches the
	 * outside world:
	 *
	 *  1. allowlist — only tools this agent declares may execute
	 *  2. schema validation — args checked/coerced against the tool's JSON Schema
	 *  3. write gate — WRITE args must be corroborated by prior READ results
	 *     or the caller's own words (evidence spans recorded)
	 *
	 * Every phase lands in the audit trail (`onToolEvent`) and event log.
	 */
	async function executeToolVerified(input: ExecuteToolInput): Promise<ToolTransportResult> {
		const startedAt = Date.now()
		const tool = allTools.find((t) => t.name === input.toolName) ?? null

		function audit(outcome: ToolTransportResult, args: Record<string, unknown>) {
			const ok = !('error' in outcome)
			const auditEvent = {
				phase: 'executed' as const,
				toolName: input.toolName,
				args,
				ok,
				result: ok ? outcome.result : null,
				error: ok ? null : outcome.error,
				elapsedMs: Date.now() - startedAt,
				atMs: Date.now(),
			}
			onToolEvent(auditEvent)
			recordEvent('tool_executed', { ...auditEvent })
			return outcome
		}

		if (!tool) {
			return audit({ error: `tool "${input.toolName}" is not in this agent's allowlist` }, input.toolArgs)
		}

		const validation = validateToolArgs(tool.parameters, input.toolArgs)
		if (!validation.ok) {
			return audit({ error: `invalid arguments for ${tool.name}: ${validation.errors.join('; ')}` }, input.toolArgs)
		}
		const args = validation.args

		if (tool.kind === 'write') {
			const sources = buildWriteGateSources(getCompletedToolResults(), input.conversationTurns, lastCallerTranscript)
			const gate = checkWriteArgs(tool.name, args, sources)
			const gateEvent = {
				phase: 'gate' as const,
				toolName: tool.name,
				args,
				allowed: gate.allowed,
				reason: gate.reason,
				evidence: gate.evidence,
				atMs: Date.now(),
			}
			onToolEvent(gateEvent)
			recordEvent('tool_gate', { ...gateEvent })
			if (!gate.allowed) {
				log.warn({ toolName: tool.name, unverified: gate.unverified }, 'write gate blocked tool execution')
				telemetry.metrics.count('mimic.tool.write_gate_blocked')
				return audit({ error: gate.reason ?? 'write gate blocked execution' }, args)
			}
			telemetry.metrics.count('mimic.tool.write_gate_passed')
		}

		const outcome = await toolTransport.execute({ ...input, toolArgs: args })
		return audit(outcome, args)
	}

	// ------------------------------------------------------------------
	// Deps bundles passed to TurnActor via CallMachine input
	// ------------------------------------------------------------------

	const runTurnDeps: RunTurnActorDeps = {
		director: {
			streamDraftTokenized: (
				transcript: string,
				controlBlock: string,
				signal?: AbortSignal,
				options?: { predictedOutput?: string },
			) => deps.director.streamDraftTokenized(transcript, controlBlock, signal, options),
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
	/** Most recent caller transcript — write-gate evidence for values the caller just said (not yet committed). */
	let lastCallerTranscript = ''

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
					mustVerify: deps.mustVerify,
					signal: abortController.signal,
				})
					.then((decision) => {
						if ((decision.decision === 'execute' || decision.decision === 'not_ready') && decision.tool) {
							const proposedEvent = {
								phase: 'proposed' as const,
								toolName: decision.tool,
								args: decision.args,
								decision: decision.decision,
								missingArgs: decision.missing ?? [],
								atMs: Date.now(),
							}
							onToolEvent(proposedEvent)
							recordEvent('tool_proposed', { ...proposedEvent })
						}
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
					.catch((err) => {
						log.error({ err, transcript: input.transcript }, 'tool intent classification failed')
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
							directorNote: 'Tool classification failed; continue without tool and ask for clarification if needed.',
						})
					})
				return () => abortController.abort()
			}),
			toolInvocation: invocationMachine.provide({
				actors: {
					executeTool: fromPromise(async ({ input }: { input: ExecuteToolInput }) => {
						return executeToolVerified(input)
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
						recordEvent('agent_playback_complete', { turnId: handle.turnId })
						actor.send({ type: 'playback_confirmed' })
					})
					.catch((err) => {
						log.error({ err }, 'waitForPlayout failed')
						recordEvent('agent_playback_complete', { turnId: handle.turnId })
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
			discardActiveTurn: () => {
				const handle = activeTurn
				if (!handle) return
				log.info(activeTurnLogFields(), 'restart-don\u2019t-resume: discarding paused pipeline audio')
				handle.pauseGate.clearBuffered()
				handle.sink.clearQueue()
				clearActiveTurn(handle.turnId, { destroySink: true })
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
			onFillerHold: (_, params) => {
				log.info(
					{ transcript: params.transcript, durationMs: params.durationMs },
					'caller speech is filler/assent — holding soft-pause instead of interrupting',
				)
				const wordCount = params.transcript.trim() ? params.transcript.trim().split(/\s+/).length : 0
				deps.metrics.recordBarge({ outcome: 'filler_held', wordCount, elapsedMs: params.durationMs })
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
				const controlBlock = buildControlBlock(p.transcript, toolState)
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
				const controlBlock = buildControlBlock(p.transcript, sCtx)
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
				const controlBlock = buildControlBlock('', {
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
				deps.onHangupRequest(params.source)
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

	function serializeTurnOutcome(outcome: import('./types.js').TurnOutcome): Record<string, unknown> {
		switch (outcome.kind) {
			case 'committed':
				return {
					kind: outcome.kind,
					turnId: outcome.turnId,
					userTranscript: outcome.turn.userTranscript,
					agentResponse: outcome.turn.agentResponse,
					endCallRequested: outcome.turn.endCallRequested,
				}
			case 'interrupted':
				return {
					kind: outcome.kind,
					turnId: outcome.turnId,
					transcript: outcome.transcript,
					reason: outcome.reason,
					heardPortion: outcome.interruptContext.heardPortion,
					fullDraft: outcome.interruptContext.fullDraft,
					sentMs: outcome.interruptContext.sentMs,
				}
			default:
				return { kind: outcome.kind, turnId: outcome.turnId, reason: outcome.reason }
		}
	}

	const getAudioSenderSnapshot = () => getActiveTurnSnapshot()

	const actor = createActor(providedCallMachine, {
		input: { runTurnDeps, commitDeps, getAudioSenderSnapshot, getTurnTunables: () => physics.getTunables() },
	}).start()

	actor.on('turn_outcome', ({ outcome }) => {
		clearActiveTurn(outcome.turnId, { destroySink: true })
		recordEvent('turn_outcome', serializeTurnOutcome(outcome))
		// call_ended interrupts say nothing about the caller's rhythm.
		if (outcome.kind === 'interrupted' && outcome.reason !== 'call_ended') {
			physics.noteInterrupt({
				sentMs: outcome.interruptContext.sentMs,
				escalatedFromSoftPause: outcome.reason === 'caller_substantive_speech',
			})
		}
	})

	// ------------------------------------------------------------------
	// Early commit on converging evidence — VAD silence + validated eager
	// draft + unchanged partial ⇒ synthetic caller_turn_complete, without
	// waiting for the Flux EndOfTurn threshold crossing.
	// ------------------------------------------------------------------

	/** Guard after a closed question — the reply shape is predictable. */
	const guardMsShortReply = 180
	/** Guard for statements/unknown shapes (~200–250ms per the design). */
	const guardMsNeutral = 240

	/** Fired-but-not-yet-confirmed commit; matched against the next real Flux final. */
	let pendingEarlyCommit: { normalized: string; firedAt: number } | null = null

	const earlyCommit = createEarlyCommitController({
		guardMsFor: () => {
			if (physics.getTunables().earlyCommitDisabled) return null
			const context = actor.getSnapshot().context
			if (context.isClosing) return null
			// After an open question, silence is thinking — never early-commit.
			if (context.expectedReply === 'long') return null
			return context.expectedReply === 'short' ? guardMsShortReply : guardMsNeutral
		},
		getWorld: (): EarlyCommitWorld => {
			const snapshot = actor.getSnapshot()
			const eager = getEagerChildSnapshot(snapshot)
			const draft = eager?.context.eagerDraft ?? null
			return {
				machineInTurn: snapshot.matches('inTurn'),
				isClosing: snapshot.context.isClosing,
				eagerReady: eager?.value === 'ready' && draft !== null,
				eagerBasisTranscript: draft?.userTranscript ?? null,
			}
		},
		commit: (transcript, confidence) => {
			sendToCallMachine({ type: 'caller_turn_complete', transcript, confidence })
		},
		onFired: ({ transcript, sinceVadEndMs }) => {
			pendingEarlyCommit = { normalized: normalizeTranscript(transcript), firedAt: Date.now() }
			log.info({ transcript, sinceVadEndMs }, 'early commit fired — skipping Flux EOT wait')
			telemetry.metrics.count('mimic.early_commit.fired')
			recordEvent('early_commit_fired', { transcript, sinceVadEndMs })
		},
		onBlocked: (reason) => {
			log.debug({ reason }, 'early commit blocked')
		},
	})

	// The eager child persists for the whole call; a draft becoming ready
	// during silence is the main early-commit trigger (drafts usually finish
	// after the VAD guard window has already elapsed).
	{
		const eagerActor = actor.getSnapshot().children['eager-pipeline'] as EagerMachineActor | undefined
		let lastEagerValue: unknown = null
		eagerActor?.subscribe((snapshot) => {
			if (snapshot.value === 'ready' && lastEagerValue !== 'ready') earlyCommit.eagerDraftReady()
			lastEagerValue = snapshot.value
		})
	}

	/** Resolve a fired early commit against the real Flux final that follows. */
	function reconcileEarlyCommit(event: { type: string; transcript?: unknown }) {
		if (!pendingEarlyCommit) return
		if (event.type === 'caller_turn_complete') {
			const normalized = normalizeTranscript(typeof event.transcript === 'string' ? event.transcript : '')
			const matched = normalized === pendingEarlyCommit.normalized
			if (matched) {
				const savedMs = Date.now() - pendingEarlyCommit.firedAt
				log.info({ savedMs }, 'early commit confirmed by Flux EOT')
				telemetry.metrics.count('mimic.early_commit.confirmed')
				telemetry.metrics.distribution('mimic.early_commit.saved_ms', savedMs, { unit: 'millisecond' })
				recordEvent('early_commit_confirmed', { savedMs })
			} else {
				log.warn('early commit superseded — Flux final differs from committed transcript')
				telemetry.metrics.count('mimic.early_commit.superseded')
				recordEvent('early_commit_superseded', {})
			}
			pendingEarlyCommit = null
		} else if (event.type === 'caller_turn_start') {
			// A new utterance began before Flux ever confirmed the old one.
			telemetry.metrics.count('mimic.early_commit.unconfirmed')
			recordEvent('early_commit_unconfirmed', {})
			pendingEarlyCommit = null
		}
	}

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

	function recordInboundEvent(event: { type: string; [key: string]: unknown }) {
		const data: Record<string, unknown> = {}
		if (typeof event.transcript === 'string') data.transcript = event.transcript
		if (typeof event.confidence === 'number') data.confidence = event.confidence
		if (typeof event.message === 'string') data.message = event.message
		if (event.type === 'start_first_turn') {
			data.hasPrepared = event.prepared != null
			if (typeof event.openingBlock === 'string') data.openingBlock = event.openingBlock
		}
		recordEvent(event.type, data)
	}

	function sendToCallMachine(event: { type: string; [key: string]: unknown }) {
		recordInboundEvent(event)
		const transcriptEvent = mapCallEventToTranscriptEvent(event)
		if (transcriptEvent) appendTranscriptEvent(transcriptEvent)
		if (typeof event.transcript === 'string' && event.transcript.trim() && event.type.startsWith('caller_')) {
			lastCallerTranscript = event.transcript
		}
		if (event.type === 'caller_turn_resumed') physics.noteTurnResumed()
		reconcileEarlyCommit(event)
		feedEarlyCommit(event)
		actor.send(event as never)
	}

	/** Every caller-facing event doubles as evidence for the early-commit
	 * controller. Its own synthetic commit re-enters here with the firing
	 * flag set, so self-observation is a no-op. */
	function feedEarlyCommit(event: { type: string; [key: string]: unknown }) {
		const transcript = typeof event.transcript === 'string' ? event.transcript : ''
		const confidence = typeof event.confidence === 'number' ? event.confidence : 0
		switch (event.type) {
			case 'vad_speech_start':
				return earlyCommit.vadSpeechStart()
			case 'vad_speech_end':
				return earlyCommit.vadSpeechEnd()
			case 'caller_update':
				return earlyCommit.callerUpdate(transcript)
			case 'caller_eager_turn':
				return earlyCommit.callerEagerTurn(transcript, confidence)
			case 'caller_turn_start':
				return earlyCommit.callerTurnStart()
			case 'caller_turn_resumed':
				return earlyCommit.callerTurnResumed()
			case 'caller_turn_complete':
				return earlyCommit.callerTurnComplete()
		}
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
		prepareGreeting,
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
			earlyCommit.close()
			actor.send({ type: 'close' })
		},
		resetToolTasks() {
			const toolActor = actor.getSnapshot().children['tool-pipeline'] as ToolSupervisorActor | undefined
			toolActor?.send({ type: 'RESET' })
			transcriptEventLog = []
		},
		stop() {
			earlyCommit.close()
			const toolActor = actor.getSnapshot().children['tool-pipeline'] as ToolSupervisorActor | undefined
			toolActor?.send({ type: 'RESET' })
			actor.stop()
		},
	}
}

export type CallMachineRuntime = ReturnType<typeof createCallMachineRuntime>

// Re-export for tests
export {
	getEagerChildSnapshot,
	getToolPipelineSnapshot,
	getTurnActorSnapshot,
	type CallMachineSnapshot,
} from './call-machine.js'
