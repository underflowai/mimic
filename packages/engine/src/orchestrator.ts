import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import OpenAI from 'openai'

import { config } from '#engine/config.js'
import { createLogger } from '#engine/logger.js'
import type { ReasoningEffort } from '#engine/models.js'

import { resolveVoiceDirectorProvider } from './intelligence/director-provider.js'
import type { MimicDirectorProvider } from './config.js'

import { createDeepgramTranscriber } from './audio/deepgram-transcriber.js'
import type { AudioTransport } from './audio/streams/types.js'
import { sanitizeForTts } from './audio/tts-sanitizer.js'
import { createTtsSpeaker } from './audio/tts-speaker.js'
import { createVoiceActivityDetector } from './audio/vad.js'
import { createBackchannelClassifier } from './backchannel/classifier.js'
import { createBackchannelEngine } from './backchannel/engine.js'
import { createCallShutdownCoordinator } from './call-shutdown-coordinator.js'
import { createBackgroundIntelligence } from './intelligence/background-intelligence.js'
import { formatUserDateTime } from './intelligence/control-block-utils.js'
import { createDirector } from './intelligence/director.js'
import { classifyEagerPromotion } from './intelligence/eager-promotion-classifier.js'
import { createWebSearcher } from './intelligence/tools/web-searcher.js'
import type { InterruptContext } from './intelligence/types.js'
import { createOrchestratorRuntime } from './orchestrator-runtime.js'
import { createCallEventRecorder } from './replay/event-log.js'
import { monotonicClock } from './shared/clock.js'
import { createCallMetrics, publishCallSummary } from './shared/metrics.js'
import { auroraPersona, type VoicePersona } from './shared/voice-persona.js'
import {
	createTurnControlBlockBuilder,
	type TurnControlBlockBuildOptions,
	type TurnControlBlockContext,
} from './turn-control-block-builder.js'
import { createCallMachineRuntime } from './turn/call-machine-runtime.js'
import type { HangupSource, TurnOutcome } from './turn/types.js'

const baseLog = createLogger('mimic')

export type { TurnControlBlockContext } from './turn-control-block-builder.js'

export interface CommittedTurnInfo {
	userTranscript: string
	assistantResponse: string
}

interface TurnCarryover {
	interruptContext: InterruptContext | null
	lastCallerTranscript: string
}

export interface CallOrchestratorConfig {
	callId?: string
	persona?: VoicePersona
	/** LLM provider for the voice director. Defaults to `'openai'`. */
	directorProvider?: MimicDirectorProvider
	/** LLM model name. Defaults to the provider's entry in the model registry. */
	directorModel?: string
	/** OpenAI `reasoning_effort` for the director. Defaults to the registry effort unless `directorModel` is set. */
	directorReasoningEffort?: ReasoningEffort
	systemPrompt: string
	userFirstName: string
	userLastName?: string
	recipient?: {
		firstName?: string
		lastName?: string
		email?: string
	}
	userTimezone?: string
	/**
	 * `userTimezone` was guessed (e.g. from the caller's area code) rather than
	 * supplied. The date line says so and the director is told to confirm the
	 * zone in passing the first time a specific time matters.
	 */
	userTimezoneInferred?: boolean
	keyterms?: string[]
	/**
	 * The transport through which the outbound audio pipeline delivers
	 * PCM to the caller. Optional: if omitted the caller must invoke
	 * `orchestrator.bindAudioTransport(transport)` before the first turn
	 * starts.
	 */
	audioTransport?: AudioTransport
	buildOpeningBlock: () => string
	buildTurnControlBlock: (ctx: TurnControlBlockContext) => string
	textQualityBlock?: string
	onTurnCommitted?: (turn: CommittedTurnInfo) => void
	onBackchannel?: (token: import('./backchannel/engine.js').BackchannelToken) => void
	tools?: import('./intelligence/tools/runner.js').ToolDefinition[]
	executeTool?: import('./intelligence/tools/transport.js').ToolExecutor
	/**
	 * Text the integrator supplied for this call (per-call data, context).
	 * Write-tool arguments that are contact details or identifiers must
	 * appear in the caller's words, a prior read result, or here; otherwise
	 * the write waits for a readback.
	 */
	toolKnownValues?: string[]
	maxCompletionTokens?: number
	/**
	 * Lets the director end the call by finishing a reply with `[end-call]`.
	 * When enabled the director is told about the tag and the tag triggers
	 * `onHangupRequested('end_call_tag')`; when disabled the tag is still
	 * stripped from speech but otherwise ignored. Defaults to `false`.
	 */
	endCallEnabled?: boolean
}

export async function createCallOrchestrator(originalConfig: CallOrchestratorConfig) {
	const callConfig = { ...originalConfig }
	const persona = callConfig.persona ?? auroraPersona
	// Full UUID so call-id correlation in logs is collision-free.
	const callId = callConfig.callId ?? randomUUID()
	const log = baseLog.child({ callId })

	// ------------------------------------------------------------------
	// Clients and base services
	// ------------------------------------------------------------------

	const {
		client: directorClient,
		model: directorModel,
		provider: directorProvider,
		reasoningEffort: directorReasoningEffort,
	} = await resolveVoiceDirectorProvider({
		provider: callConfig.directorProvider,
		model: callConfig.directorModel,
		reasoningEffort: callConfig.directorReasoningEffort,
	})
	const openai = new OpenAI({ apiKey: config.mimic.openai.apiKey })

	log.info(
		{ provider: directorProvider, model: directorModel, reasoningEffort: directorReasoningEffort },
		'director provider selected',
	)

	const transcriber = createDeepgramTranscriber()
	const tts = createTtsSpeaker({ voiceId: persona.ttsVoiceId })
	const specTts = createTtsSpeaker({ voiceId: persona.ttsVoiceId })
	let turnCount = 0
	const director = createDirector({
		client: directorClient,
		model: directorModel,
		reasoningEffort: directorReasoningEffort,
		systemPrompt: callConfig.systemPrompt,
		maxCompletionTokens: callConfig.maxCompletionTokens,
	})
	const webSearcher = createWebSearcher(openai, { agentName: persona.firstName })
	const metrics = createCallMetrics()
	const events = new EventEmitter()
	const endCallEnabled = callConfig.endCallEnabled === true

	// ------------------------------------------------------------------
	// Call-scoped mutable state
	// ------------------------------------------------------------------

	const callAbort = new AbortController()
	const clock = monotonicClock
	const startedAt = clock.now()
	const eventRecorder = createCallEventRecorder({ clock })

	const backchannelClassifier = createBackchannelClassifier(openai, callAbort.signal)
	let backchannelEngine: ReturnType<typeof createBackchannelEngine> | null = null
	const previousTurnOutcome: TurnCarryover = { interruptContext: null, lastCallerTranscript: '' }

	function interruptCarryoverForAgentInitiatedTurn() {
		return previousTurnOutcome
	}

	function interruptCarryoverForCallerTurn() {
		const snapshot = { ...previousTurnOutcome }
		previousTurnOutcome.interruptContext = null
		return snapshot
	}

	// ------------------------------------------------------------------
	// Background intelligence
	// ------------------------------------------------------------------

	const backgroundIntelligence = createBackgroundIntelligence({
		client: openai,
		callSignal: callAbort.signal,
		agentName: persona.firstName,
		transcriber,
		director,
	})
	if (callConfig.keyterms && callConfig.keyterms.length > 0) {
		backgroundIntelligence.addKeyterms(callConfig.keyterms)
	}

	// ------------------------------------------------------------------
	// Control block assembly
	// ------------------------------------------------------------------

	const turnControlBlockBuilder = await createTurnControlBlockBuilder({
		getUserFirstName: () => callConfig.userFirstName,
		getRecipient: () =>
			callConfig.recipient ?? {
				firstName: callConfig.userFirstName || undefined,
				lastName: callConfig.userLastName,
			},
		getUserTimezone: () => callConfig.userTimezone,
		getUserTimezoneInferred: () => callConfig.userTimezoneInferred === true,
		buildTurnControlBlock: (ctx) => callConfig.buildTurnControlBlock(ctx),
		textQualityBlock: callConfig.textQualityBlock,
		endCallEnabled,
	})

	function assembleControlBlock(transcript: string, outcome: TurnCarryover, opts?: TurnControlBlockBuildOptions) {
		return turnControlBlockBuilder.build(transcript, outcome, opts)
	}

	// ------------------------------------------------------------------
	// Turn engine
	// ------------------------------------------------------------------

	let boundAudioTransport: AudioTransport | null = callConfig.audioTransport ?? null

	function bindAudioTransport(transport: AudioTransport) {
		boundAudioTransport = transport
	}

	const callMachineRuntime = createCallMachineRuntime({
		callSignal: callAbort.signal,
		clock,
		tts,
		specTts,
		director,
		backgroundClient: openai,
		metrics,
		getAudioTransport: () => {
			if (!boundAudioTransport) {
				throw new Error('audio transport not bound — call orchestrator.bindAudioTransport() first')
			}
			return boundAudioTransport
		},
		backgroundIntelligence,
		incrementTurn: () => {
			turnCount++
		},
		configureTranscriber: (opts) => transcriber.configure(opts),
		sanitize: sanitizeForTts,
		classifyPromotion: (specTranscript, finalTranscript, draftResponse, signal) =>
			classifyEagerPromotion(openai, specTranscript, finalTranscript, draftResponse, signal),
		buildControlBlock: (transcript, opts) => {
			const agentInitiated = opts?.silenceFollowUp || opts?.silenceClosing
			const outcome = agentInitiated ? interruptCarryoverForAgentInitiatedTurn() : interruptCarryoverForCallerTurn()
			return assembleControlBlock(transcript, outcome, opts)
		},
		webSearcher,
		getCallerDateTime: () =>
			formatUserDateTime(callConfig.userTimezone, { inferred: callConfig.userTimezoneInferred === true }),
		getDirectorTurns: () => director.listTurns(),
		tools: callConfig.tools,
		executeTool: callConfig.executeTool,
		toolKnownValues: callConfig.toolKnownValues,
		eventRecorder,
		endCallEnabled,
		// Either the silence watchdog exhausted its check-in budget or the
		// director ended its reply with `[end-call]`. Emit the hangup event so
		// the transport layer (createVoiceAgent) can tear down the room — that
		// disconnect flow also triggers our own `shutdownCoordinator.close()`
		// via the regular session-end path.
		onHangupRequested: (source) => {
			events.emit('hangupRequested', source)
		},
	})
	const callMachineActor = callMachineRuntime.actor

	function recordInterruptHistory(outcome: TurnOutcome) {
		if (outcome.kind !== 'committed' && outcome.kind !== 'interrupted') return
		const wasInterrupted = outcome.kind === 'interrupted' && outcome.interruptContext.heardPortion.length > 0
		if (wasInterrupted) {
			previousTurnOutcome.interruptContext = outcome.interruptContext
		}
	}

	// ------------------------------------------------------------------
	// Backchannel engine (lazy — created when onBackchannel is configured)
	// ------------------------------------------------------------------

	function ensureBackchannelEngine() {
		if (backchannelEngine || !callConfig.onBackchannel) return
		backchannelEngine = createBackchannelEngine({
			onFire: (token) => callConfig.onBackchannel?.(token),
			classifyBackchannel: (transcript) => backchannelClassifier.classify(transcript),
			clock,
		})
	}

	const turnOutcomeSubscription = callMachineActor.on('turn_outcome', ({ outcome }) => {
		backchannelEngine?.send({ type: 'turn_outcome', outcome })
		recordInterruptHistory(outcome)
		if (outcome.kind !== 'committed') return

		previousTurnOutcome.lastCallerTranscript = outcome.turn.userTranscript
		backgroundIntelligence.runPostCommitTasks({
			userTranscript: outcome.turn.userTranscript,
			agentResponse: outcome.turn.agentResponse,
		})
		callConfig.onTurnCommitted?.({
			userTranscript: outcome.turn.userTranscript,
			assistantResponse: outcome.turn.agentResponse,
		})
	})

	// ------------------------------------------------------------------
	// Runtime lifecycle
	// ------------------------------------------------------------------

	const runtime = createOrchestratorRuntime({
		log,
		transcriber,
		tts,
		specTts,
		callMachineRuntime: {
			sendToCallMachine: (event) => callMachineRuntime.sendToCallMachine(event),
		},
		createVoiceActivityDetector,
		getBackchannelEngine: () => backchannelEngine,
		ensureBackchannelEngine,
		buildOpeningBlock: () => callConfig.buildOpeningBlock(),
		getCallKeyterms: () => callConfig.keyterms,
	})

	// ------------------------------------------------------------------
	// Event plumbing — track registrations so close() can detach listeners.
	// ------------------------------------------------------------------

	type InternalEventName = 'hangupRequested'

	function registerInternalListener(event: InternalEventName, listener: (source: HangupSource) => void) {
		events.on(event, listener)
		return () => events.off(event, listener)
	}

	// ------------------------------------------------------------------
	// Shutdown
	// ------------------------------------------------------------------

	const shutdownCoordinator = createCallShutdownCoordinator({
		log,
		clock,
		startedAt,
		markClosing: () => callMachineRuntime.markClosing(),
		abortCall: () => callAbort.abort(),
		interruptActiveTurn: () => callMachineRuntime.interruptActiveTurn('call_ended'),
		resetToolCoordinator: () => callMachineRuntime.resetToolTasks(),
		shutdownRuntime: async () => {
			await runtime.shutdown()
			turnOutcomeSubscription.unsubscribe()
			callMachineActor.stop()
			events.removeAllListeners()
		},
		drainBackgroundIntelligence: () => backgroundIntelligence.drain(),
		listTurns: () => director.listTurns(),
		getBriefingTurnCount: () => turnCount,
		snapshotMetrics: () => metrics.snapshot(),
		summarizeMetrics: () => metrics.summarize(),
		publishMetrics: (snapshot, durationSeconds) => publishCallSummary(snapshot, durationSeconds),
		snapshotEvents: (summary, durationSeconds) => {
			eventRecorder.record('call_summary', { durationSeconds, ...summary })
			return eventRecorder.snapshot()
		},
	})

	// ------------------------------------------------------------------
	// Public API
	// ------------------------------------------------------------------

	function configure(
		updates: Partial<
			Pick<
				CallOrchestratorConfig,
				'userFirstName' | 'userLastName' | 'userTimezone' | 'userTimezoneInferred' | 'keyterms' | 'onBackchannel'
			>
		>,
	) {
		if (updates.userFirstName !== undefined) callConfig.userFirstName = updates.userFirstName
		if (updates.userLastName !== undefined) callConfig.userLastName = updates.userLastName
		if (updates.userTimezone !== undefined) {
			callConfig.userTimezone = updates.userTimezone
			// A zone set explicitly after the call started is a confirmed one unless told otherwise.
			callConfig.userTimezoneInferred = updates.userTimezoneInferred ?? false
		} else if (updates.userTimezoneInferred !== undefined) {
			callConfig.userTimezoneInferred = updates.userTimezoneInferred
		}
		if (updates.keyterms !== undefined) callConfig.keyterms = updates.keyterms
		if (updates.onBackchannel !== undefined) {
			callConfig.onBackchannel = updates.onBackchannel
			ensureBackchannelEngine()
		}
	}

	return {
		configure,
		bindAudioTransport,
		connectServices: runtime.connectServices,
		start: runtime.start,
		handleCallerAudio: runtime.handleCallerAudio,
		/**
		 * Fires when the engine has decided the call should end: either the
		 * silence watchdog ran out of check-ins or (with `endCallEnabled`) the
		 * director finished a reply with `[end-call]`. In both cases the
		 * goodbye turn has already committed. The transport layer should use
		 * this signal to disconnect the room, which in turn closes the caller.
		 */
		onHangupRequested: (callback: (source: HangupSource) => void) =>
			registerInternalListener('hangupRequested', callback),
		isAgentSpeaking: () => callMachineRuntime.isAgentStreaming(),
		close: () => shutdownCoordinator.close(),
	}
}

export type CallOrchestrator = Awaited<ReturnType<typeof createCallOrchestrator>>
