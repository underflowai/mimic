import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import OpenAI from 'openai'

import { config } from '#engine/config.js'
import { createLogger } from '#engine/logger.js'

import { resolveVoiceDirectorProvider } from './intelligence/director-provider.js'

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
import { createCallMetrics, publishCallSummary } from './shared/metrics.js'
import { auroraPersona, type VoicePersona } from './shared/voice-persona.js'
import {
	createTurnControlBlockBuilder,
	type TurnControlBlockBuildOptions,
	type TurnControlBlockContext,
} from './turn-control-block-builder.js'
import { createCallMachineRuntime } from './turn/call-machine-runtime.js'
import type { TurnOutcome } from './turn/types.js'

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
	systemPrompt: string
	userFirstName: string
	userLastName?: string
	recipient?: {
		firstName?: string
		lastName?: string
		email?: string
	}
	userTimezone?: string
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
	executeSdkTool?: import('./intelligence/tools/transport.js').SdkToolExecutor
	maxCompletionTokens?: number
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
	} = await resolveVoiceDirectorProvider()
	const openai = new OpenAI({ apiKey: config.mimic.openai.apiKey })

	log.info({ provider: directorProvider, model: directorModel }, 'director provider selected')

	const transcriber = createDeepgramTranscriber({ encoding: 'linear16', sampleRate: 16000 })
	const tts = createTtsSpeaker({ voiceId: persona.ttsVoiceId })
	const specTts = createTtsSpeaker({ voiceId: persona.ttsVoiceId })
	let turnCount = 0
	const director = createDirector({
		client: directorClient,
		model: directorModel,
		systemPrompt: callConfig.systemPrompt,
		maxCompletionTokens: callConfig.maxCompletionTokens,
	})
	const webSearcher = createWebSearcher(openai)
	const metrics = createCallMetrics()
	const events = new EventEmitter()

	// ------------------------------------------------------------------
	// Call-scoped mutable state
	// ------------------------------------------------------------------

	const callAbort = new AbortController()
	const startTime = Date.now()

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
		transcriber,
		director,
	})
	if (callConfig.keyterms && callConfig.keyterms.length > 0) {
		backgroundIntelligence.addKeyterms(callConfig.keyterms)
	}

	// ------------------------------------------------------------------
	// Control block assembly
	// ------------------------------------------------------------------

	const turnControlBlockBuilder = createTurnControlBlockBuilder({
		getUserFirstName: () => callConfig.userFirstName,
		getRecipient: () =>
			callConfig.recipient ?? {
				firstName: callConfig.userFirstName || undefined,
				lastName: callConfig.userLastName,
			},
		getUserTimezone: () => callConfig.userTimezone,
		buildTurnControlBlock: (ctx) => callConfig.buildTurnControlBlock(ctx),
		textQualityBlock: callConfig.textQualityBlock,
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
		getCallerDateTime: () => formatUserDateTime(callConfig.userTimezone),
		getDirectorTurns: () => director.listTurns(),
		tools: callConfig.tools,
		executeSdkTool: callConfig.executeSdkTool,
		// Silence watchdog exhausted its check-in budget. Emit the hangup
		// event so the transport layer (createVoiceAgent) can tear down the
		// LiveKit room — that disconnect flow also triggers our own
		// `shutdownCoordinator.close()` via the regular session-end path,
		// which closes the caller out of the room at the same time.
		onSilenceHangup: () => {
			events.emit('hangupRequested')
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
		})
	}

	const turnOutcomeSubscription = callMachineActor.on('turn_outcome', ({ outcome }) => {
		backchannelEngine?.send({ type: 'turn_outcome', outcome })
		recordInterruptHistory(outcome)
		if (outcome.kind !== 'committed') return

		previousTurnOutcome.lastCallerTranscript = outcome.turn.userTranscript
		backgroundIntelligence
			.runPostCommitTasks({
				userTranscript: outcome.turn.userTranscript,
				agentResponse: outcome.turn.agentResponse,
			})
			.catch((err) => {
				log.error({ err }, 'post-commit tasks failed')
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

	function registerInternalListener(event: InternalEventName, listener: () => void) {
		events.on(event, listener)
		return () => events.off(event, listener)
	}

	// ------------------------------------------------------------------
	// Shutdown
	// ------------------------------------------------------------------

	const shutdownCoordinator = createCallShutdownCoordinator({
		log,
		startTimeMs: startTime,
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
	})

	// ------------------------------------------------------------------
	// Public API
	// ------------------------------------------------------------------

	function configure(
		updates: Partial<
			Pick<CallOrchestratorConfig, 'userFirstName' | 'userLastName' | 'userTimezone' | 'keyterms' | 'onBackchannel'>
		>,
	) {
		if (updates.userFirstName !== undefined) callConfig.userFirstName = updates.userFirstName
		if (updates.userLastName !== undefined) callConfig.userLastName = updates.userLastName
		if (updates.userTimezone !== undefined) callConfig.userTimezone = updates.userTimezone
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
		 * Fires when the silence watchdog has decided the call should end (the
		 * goodbye turn has already committed). The transport layer should use
		 * this signal to disconnect the room, which in turn closes the caller.
		 */
		onHangupRequested: (callback: () => void) => registerInternalListener('hangupRequested', callback),
		isAgentSpeaking: () => callMachineRuntime.isAgentStreaming(),
		close: () => shutdownCoordinator.close(),
	}
}

export type CallOrchestrator = Awaited<ReturnType<typeof createCallOrchestrator>>
