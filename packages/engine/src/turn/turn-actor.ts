/**
 * TurnActor — per-turn lifecycle machine.
 */

import { fromCallback, sendTo, setup, type DoneActorEvent, type ErrorActorEvent, type SnapshotFrom } from 'xstate'

import { config } from '#engine/config.js'

import { sanitizeForTranscript } from '../audio/tts-sanitizer.js'
import type { InterruptContext } from '../intelligence/types.js'
import { estimateHeardPortion } from '../shared/audio-pacing.js'
import type { Clock } from '../shared/clock.js'
import type { SoftPauseOutcome, SoftPauseSource, TurnTiming } from '../shared/metrics.js'
import { commitActorLogic, type CommitActorDeps, type CommitActorOutput } from './actors/commit-actor.js'
import { playbackWaitActor } from './actors/playback-wait-actor.js'
import { classifyCallerSpeech } from './caller-speech.js'
import {
	runTurnActorLogic,
	type RunTurnActorDeps,
	type RunTurnActorEvent,
	type RunTurnActorInput,
	type RunTurnStrategyInput,
	type StreamResult,
} from './actors/run-turn-actor.js'
import type { CommittedTurn, InterruptReason, PlaybackSnapshot, TurnOutcome } from './types.js'

export type TurnActorExecutionStrategy = RunTurnStrategyInput

type InterruptDiscardReason = Extract<TurnOutcome, { kind: 'discarded' }>['reason']
type StreamResultPayload = StreamResult
type InterruptResource = 'abort' | 'audio' | 'tts' | 'barge' | 'softPause'
type CallEndedCommit = 'userOnly' | 'draft' | null

interface InterruptConfig {
	resources: InterruptResource[]
	reason?: InterruptReason
	includeFade?: boolean
	softPauseOutcome?: SoftPauseOutcome
	recordSubstantiveTimeout?: boolean
	onCallEndedCommit?: CallEndedCommit
	commitUserOnlyOnInterrupt?: boolean
	clearVad?: boolean
	clearDraft?: boolean
}

export interface TurnActorInput {
	strategy: TurnActorExecutionStrategy
	turnId: number
	userTranscript: string
	generationStartedAt: number
	lastTurnCompleteAt: number
	callerVadEndAt: number
	runTurnDeps: RunTurnActorDeps
	commitDeps: CommitActorDeps
	getPlaybackSnapshot: () => PlaybackSnapshot
	clock: Clock
}

export interface TurnActorContext {
	input: TurnActorInput
	clock: Clock
	turnId: number
	userTranscript: string
	agentResponse: string
	draftResponse: string
	endCallRequested: boolean
	holdRequested: boolean
	committed: CommittedTurn | null
	interruptReason: InterruptReason | null
	computedInterruptContext: InterruptContext | null
	discardReason: InterruptDiscardReason | null
	abort: AbortController | null
	pausedAt: number
	softPauseSource: SoftPauseSource
	/** Latest transcriber text heard during the current soft pause. */
	pauseTranscript: string
	/** The transcriber reported a turn start/resume during the current soft pause. */
	pauseFluxEvidence: boolean
	/**
	 * The acknowledgement we resumed over in the caller's current utterance
	 * ('' when none). While set, every interim transcript is re-classified so
	 * the resume can be revoked the moment the words grow past it.
	 */
	resumedOverTranscript: string
	vadSpeechStartAt: number
	firstAudioAt: number | null
	draftMs: number
	ttsFirstByteMs: number | null
	ttftMs: number | null
	ttcMs: number | null
	timingKind: TurnTiming['kind']
	generationStartedAt: number
	lastTurnCompleteAt: number
	lastVadSpeechEndAt: number
	callerVadEndAt: number
}

type TurnActorEvent =
	| RunTurnActorEvent
	| { type: 'interrupt'; reason: InterruptReason }
	| { type: 'caller_turn_start'; transcript?: string }
	| { type: 'caller_turn_resumed'; transcript?: string }
	| { type: 'caller_update'; transcript: string }
	| { type: 'playback_confirmed' }
	| { type: 'vad_speech_start' }
	| { type: 'vad_speech_end' }
	| { type: 'playback_settled'; triggeredBy: 'playback_confirmed' | 'caller_turn_start' }
	| DoneActorEvent<CommitActorOutput, string>
	| ErrorActorEvent<unknown, string>

function strategyToTimingKind(strategy: TurnActorExecutionStrategy): TurnTiming['kind'] {
	if (strategy.kind === 'presynthesized') return 'presynthesized'
	if (strategy.kind === 'first_turn') return 'first_turn'
	return 'fresh'
}

function isCallEndedInterrupt(event: TurnActorEvent) {
	return event.type === 'interrupt' && event.reason === 'call_ended'
}

function interruptReasonFrom(event: TurnActorEvent, fallback: InterruptReason) {
	return event.type === 'interrupt' ? event.reason : fallback
}

function hasResource(config: InterruptConfig, resource: InterruptResource) {
	return config.resources.includes(resource)
}

function softPauseDurationMs(context: TurnActorContext) {
	return context.pausedAt > 0 ? context.clock.now() - context.pausedAt : 0
}

const now = ({ context }: { context: TurnActorContext }) => context.clock.now()

const turnActorSetup = setup({
	types: {
		context: {} as TurnActorContext,
		input: {} as TurnActorInput,
		output: {} as TurnOutcome,
		events: {} as TurnActorEvent,
	},
	actors: {
		runTurnPipeline: fromCallback<RunTurnActorEvent, RunTurnActorInput>(({ input, sendBack }) => {
			void input
			void sendBack
		}),
		playbackWait: playbackWaitActor,
		commitActor: commitActorLogic,
	},
	actions: {
		onPlaybackComplete: () => {},
		onSuspendAudio: () => {},
		clearBuffer: () => {},
		drainAudioFade: () => {},
		interruptTts: () => {},
		cancelEager: () => {},
		recordBarge: (_, _params: { draft: string }) => {},
		estimateHeardAndCommitPartial: (
			_,
			_params: { draft: string; userTranscript: string; interruptContext: InterruptContext },
		) => {},
		commitDraft: (_, _params: { userTranscript: string; draftResponse: string }) => {},
		commitUserOnly: (_, _params: { userTranscript: string }) => {},
		recordSoftPauseMetrics: (
			_,
			_params: { source: SoftPauseSource; outcome: SoftPauseOutcome; durationMs: number },
		) => {},
		onSubstantiveSpeechTimeout: (_, _params: { vadSpeechStartAt: number; transcript: string }) => {},
		recordShortResumedBarge: () => {},
		/** The pause resolved as a backchannel: audio resumes; the decision stays revocable. */
		recordBackchannelResume: (_, _params: { transcript: string }) => {},
		/** VAD stayed active but the transcriber never heard words: resume and treat it as noise. */
		recordVadOnlyResume: () => {},
		/** Tell the call machine the active turn resumed over the caller's current utterance. */
		markBackchannelResumed: (_, _params: { transcript: string }) => {},
		/** The resumed-over utterance grew into real speech: the agent yields after all. */
		recordResumeRevoked: (_, _params: { resumedOver: string; transcript: string }) => {},
		resetPauseState: () => {},
		flushPausedBuffer: () => {},
	},
	delays: {
		substantiveSpeechMs: () => config.mimic.turnTaking.substantiveSpeechMs,
		vadOnlyGraceMs: () => config.mimic.turnTaking.vadOnlyGraceMs,
		yieldWindowMs: () => config.mimic.turnTaking.yieldWindowMs,
		playbackTimeoutMs: () => config.mimic.timeouts.playbackConfirmMs,
	},
	guards: {
		isCallEnded: ({ event }) => isCallEndedInterrupt(event as TurnActorEvent),
		hasDraftFinished: ({ context }) => context.draftMs > 0,
		pauseIsBackchannel: ({ context }) => classifyPause(context) === 'backchannel',
		// After a backchannel resume, the caller kept going: "yeah… but actually".
		resumedUtteranceGrewIntoSpeech: ({ context, event }) =>
			context.resumedOverTranscript !== '' &&
			classifyCallerSpeech(eventTranscript(event as TurnActorEvent)) === 'speech',
		// Words from the transcriber, or a turn start we never got words for
		// (hosts that don't forward transcripts): the caller wants the floor.
		pauseIsSpeech: ({ context }) => {
			const kind = classifyPause(context)
			return kind === 'speech' || (kind === 'none' && context.pauseFluxEvidence)
		},
	},
})

function classifyPause(context: TurnActorContext) {
	return classifyCallerSpeech(context.pauseTranscript)
}

const assignOnAudioStarted = turnActorSetup.assign({
	agentResponse: ({ event }) => (event.type === 'audio_started' ? event.agentResponse : ''),
	draftResponse: ({ event }) => (event.type === 'audio_started' ? event.agentResponse : ''),
	endCallRequested: ({ event }) => event.type === 'audio_started' && event.endCallRequested === true,
	holdRequested: ({ event }) => event.type === 'audio_started' && event.holdRequested === true,
})

const assignOnFirstAudioSent = turnActorSetup.assign({
	firstAudioAt: ({ context, event }) => (event.type === 'first_audio_sent' ? event.at : context.firstAudioAt),
})

const assignOnStreamDone = turnActorSetup.assign({
	firstAudioAt: ({ event }) => (event.type === 'stream_done' ? event.result.firstAudioAt : null),
	draftMs: ({ event }) => (event.type === 'stream_done' ? event.result.draftMs : 0),
	ttsFirstByteMs: ({ event }) => (event.type === 'stream_done' ? event.result.ttsFirstByteMs : null),
	ttftMs: ({ event }) => (event.type === 'stream_done' ? event.result.ttftMs : null),
	ttcMs: ({ event }) => (event.type === 'stream_done' ? event.result.ttcMs : null),
	agentResponse: ({ context, event }) => {
		if (event.type !== 'stream_done') return context.agentResponse
		const result = event.result as StreamResultPayload
		return result.agentResponse || context.agentResponse
	},
	endCallRequested: ({ context, event }) =>
		event.type === 'stream_done' ? event.result.endCallRequested : context.endCallRequested,
	holdRequested: ({ context, event }) =>
		event.type === 'stream_done' ? event.result.holdRequested : context.holdRequested,
})

const assignVadSpeechStart = turnActorSetup.assign({ vadSpeechStartAt: now })
const assignVadSpeechEnd = turnActorSetup.assign({ lastVadSpeechEndAt: now })
const clearVadSpeechStart = turnActorSetup.assign({ vadSpeechStartAt: 0 })

function recordSoftPauseMetrics(outcome: SoftPauseOutcome) {
	return turnActorSetup.enqueueActions(({ context, enqueue }) => {
		enqueue({
			type: 'recordSoftPauseMetrics',
			params: { source: context.softPauseSource, outcome, durationMs: softPauseDurationMs(context) },
		})
	})
}

function enterSoftPause(source: SoftPauseSource) {
	return turnActorSetup.enqueueActions(({ enqueue }) => {
		enqueue('onSuspendAudio')
		enqueue.assign({
			pausedAt: now,
			softPauseSource: source,
			pauseTranscript: '',
			pauseFluxEvidence: false,
			resumedOverTranscript: '',
		})
	})
}

function eventTranscript(event: TurnActorEvent) {
	return 'transcript' in event && typeof event.transcript === 'string' ? event.transcript.trim() : ''
}

/** Remember what the transcriber heard during this pause; longer text wins over a stale fragment. */
const notePauseEvidence = turnActorSetup.assign({
	pauseTranscript: ({ context, event }) => eventTranscript(event as TurnActorEvent) || context.pauseTranscript,
	pauseFluxEvidence: ({ context, event }) =>
		context.pauseFluxEvidence || event.type === 'caller_turn_start' || event.type === 'caller_turn_resumed',
})

const clearPauseState = turnActorSetup.assign({
	pausedAt: 0,
	softPauseSource: 'unknown',
	pauseTranscript: '',
	pauseFluxEvidence: false,
	lastVadSpeechEndAt: now,
})

/** Caller stopped (VAD end) before we had to decide: a short noise or a one-word backchannel. */
const resumeFromSoftPause = turnActorSetup.enqueueActions(({ enqueue }) => {
	enqueue('flushPausedBuffer')
	enqueue(recordSoftPauseMetrics('resumed'))
	enqueue('recordShortResumedBarge')
	enqueue(clearPauseState)
})

/**
 * The transcriber heard only listening noises or a short acknowledgement:
 * keep talking, but remember the words so the decision can be revoked if
 * the caller keeps going.
 */
const resumeFromBackchannel = turnActorSetup.enqueueActions(({ context, enqueue }) => {
	enqueue('flushPausedBuffer')
	enqueue(recordSoftPauseMetrics('resumed'))
	enqueue({ type: 'recordBackchannelResume', params: { transcript: context.pauseTranscript } })
	enqueue({ type: 'markBackchannelResumed', params: { transcript: context.pauseTranscript } })
	enqueue(clearPauseState)
	enqueue.assign({ resumedOverTranscript: context.pauseTranscript })
})

/** The resumed-over acknowledgement grew into speech while audio was flowing again. */
const revokeResume = turnActorSetup.enqueueActions(({ context, event, enqueue }) => {
	enqueue({
		type: 'recordResumeRevoked',
		params: { resumedOver: context.resumedOverTranscript, transcript: eventTranscript(event as TurnActorEvent) },
	})
	enqueue.assign({ resumedOverTranscript: '' })
})

/** VAD alone, no words after the grace window: treat as noise. */
const resumeFromVadOnly = turnActorSetup.enqueueActions(({ enqueue }) => {
	enqueue('flushPausedBuffer')
	enqueue(recordSoftPauseMetrics('resumed'))
	enqueue('recordVadOnlyResume')
	enqueue(clearPauseState)
})

const assignStreamDoneWhilePaused = turnActorSetup.enqueueActions(({ event, enqueue }) => {
	if (event.type === 'stream_done') enqueue(assignOnStreamDone)
})

type TurnEnqueue = Parameters<Parameters<(typeof turnActorSetup)['enqueueActions']>[0]>[0]['enqueue']

function maybeRecordTimeout(enqueue: TurnEnqueue, context: TurnActorContext, config: InterruptConfig) {
	if (!config.recordSubstantiveTimeout) return
	enqueue({
		type: 'onSubstantiveSpeechTimeout',
		params: { vadSpeechStartAt: context.vadSpeechStartAt, transcript: context.pauseTranscript },
	})
}

function maybeRecordSoftPauseExit(enqueue: TurnEnqueue, config: InterruptConfig) {
	if (!config.softPauseOutcome) return
	enqueue(recordSoftPauseMetrics(config.softPauseOutcome))
}

function maybeAbortGeneration(context: TurnActorContext, config: InterruptConfig) {
	if (!hasResource(config, 'abort') || !context.abort) return
	context.abort.abort()
}

function cleanupAudio(enqueue: TurnEnqueue, config: InterruptConfig) {
	if (!hasResource(config, 'audio')) return
	enqueue('clearBuffer')
	if (config.includeFade !== false) enqueue('drainAudioFade')
}

function cleanupTts(enqueue: TurnEnqueue, config: InterruptConfig) {
	if (hasResource(config, 'tts')) enqueue('interruptTts')
}

function cleanupBarge(enqueue: TurnEnqueue, context: TurnActorContext, config: InterruptConfig) {
	if (!hasResource(config, 'barge')) return
	const { sentMs, playedMs, words } = context.input.getPlaybackSnapshot()
	const spokenDraft = sanitizeForTranscript(context.draftResponse)
	const heardPortion = estimateHeardPortion(spokenDraft, playedMs, words)
	const interruptCtx: InterruptContext = { fullDraft: spokenDraft, sentMs, playedMs, heardPortion }
	enqueue.assign({ computedInterruptContext: interruptCtx })
	enqueue({ type: 'recordBarge', params: { draft: spokenDraft } })
	if (interruptCtx.heardPortion) {
		enqueue({
			type: 'estimateHeardAndCommitPartial',
			params: { draft: context.draftResponse, userTranscript: context.userTranscript, interruptContext: interruptCtx },
		})
		return
	}
	if (context.userTranscript.trim()) {
		enqueue({ type: 'commitUserOnly', params: { userTranscript: context.userTranscript } })
	}
}

function maybeCommitOnCallEnded(
	enqueue: TurnEnqueue,
	context: TurnActorContext,
	event: TurnActorEvent,
	commit: CallEndedCommit,
) {
	if (!isCallEndedInterrupt(event) || !commit) return
	if (commit === 'userOnly' && context.userTranscript)
		enqueue({ type: 'commitUserOnly', params: { userTranscript: context.userTranscript } })
	if (commit === 'draft')
		enqueue({
			type: 'commitDraft',
			params: { userTranscript: context.userTranscript, draftResponse: context.draftResponse },
		})
}

function maybeCommitUserOnlyOnInterrupt(
	enqueue: TurnEnqueue,
	context: TurnActorContext,
	event: TurnActorEvent,
	config: InterruptConfig,
) {
	if (!config.commitUserOnlyOnInterrupt) return
	if (!context.userTranscript.trim()) return
	if (isCallEndedInterrupt(event) && config.onCallEndedCommit === 'userOnly') return
	enqueue({ type: 'commitUserOnly', params: { userTranscript: context.userTranscript } })
}

function applyInterruptAssign(enqueue: TurnEnqueue, event: TurnActorEvent, config: InterruptConfig) {
	enqueue.assign({ interruptReason: config.reason ?? interruptReasonFrom(event, 'caller_started_speaking') })
	if (hasResource(config, 'abort')) enqueue.assign({ abort: null })
	if (config.clearVad !== false) enqueue.assign({ vadSpeechStartAt: 0 })
	if (hasResource(config, 'softPause'))
		enqueue.assign({ pausedAt: 0, softPauseSource: 'unknown', pauseTranscript: '', pauseFluxEvidence: false })
	if (config.clearDraft) enqueue.assign({ draftResponse: '' })
}

function interruptWith(config: InterruptConfig) {
	return turnActorSetup.enqueueActions(({ context, event, enqueue }) => {
		maybeRecordTimeout(enqueue, context, config)
		maybeRecordSoftPauseExit(enqueue, config)
		maybeAbortGeneration(context, config)
		cleanupAudio(enqueue, config)
		cleanupTts(enqueue, config)
		cleanupBarge(enqueue, context, config)
		maybeCommitOnCallEnded(enqueue, context, event as TurnActorEvent, config.onCallEndedCommit ?? null)
		maybeCommitUserOnlyOnInterrupt(enqueue, context, event as TurnActorEvent, config)
		enqueue('cancelEager')
		applyInterruptAssign(enqueue, event as TurnActorEvent, config)
	})
}

// ── Interrupt plan builder ───────────────────────────────────────────
//
// Maps (TurnActor state, trigger) → InterruptConfig. Each interrupt
// transition in the machine below calls `interruptWith(plan)` where
// `plan` is produced here, making the state-to-cleanup relationship
// explicit and auditable in one place.

type InterruptState = 'generating' | 'streaming' | 'softPaused' | 'awaiting'
type InterruptTrigger = 'caller' | 'call_ended' | 'substantive_timeout' | 'yield_timer'

function buildInterruptPlan(state: InterruptState, trigger: InterruptTrigger): InterruptConfig {
	if (state === 'awaiting' && trigger === 'call_ended') {
		return { resources: [], reason: 'call_ended', onCallEndedCommit: 'draft', clearVad: false }
	}

	const resources: InterruptResource[] = []

	// abort controller exists during executing (generating/streaming/softPaused) but is
	// already nulled on awaitingPlayback entry
	if (state !== 'awaiting') resources.push('abort')

	resources.push('audio', 'tts')

	// barge (heard-portion estimation) only applies once audio has been sent to the caller
	if (state !== 'generating') resources.push('barge')

	if (state === 'softPaused') resources.push('softPause')

	const plan: InterruptConfig = { resources }

	// generating has no draft worth keeping and should commit the user transcript
	if (state === 'generating') {
		plan.commitUserOnlyOnInterrupt = true
		plan.clearDraft = true
	}

	// skip fade-out when audio is already paused
	if (state === 'softPaused') plan.includeFade = false

	if (trigger === 'substantive_timeout') {
		plan.reason = 'caller_substantive_speech'
		plan.softPauseOutcome = 'escalated_to_interrupt'
		plan.recordSubstantiveTimeout = true
	} else if (state === 'softPaused') {
		plan.softPauseOutcome = 'interrupted'
	}

	if (trigger === 'yield_timer') plan.reason = 'caller_started_speaking'

	return plan
}

const interruptFromGenerating = interruptWith(buildInterruptPlan('generating', 'caller'))
const interruptFromStreaming = interruptWith(buildInterruptPlan('streaming', 'caller'))
const interruptFromRevokedResume = interruptWith({
	...buildInterruptPlan('streaming', 'caller'),
	reason: 'caller_substantive_speech',
})
const interruptFromRevokedResumeAwaiting = interruptWith({
	...buildInterruptPlan('awaiting', 'caller'),
	reason: 'caller_substantive_speech',
})
const interruptFromSoftPaused = interruptWith(buildInterruptPlan('softPaused', 'caller'))
const interruptFromSubstantiveTimeout = interruptWith(buildInterruptPlan('softPaused', 'substantive_timeout'))
const interruptFromAwaitingCallEnded = interruptWith(buildInterruptPlan('awaiting', 'call_ended'))
const interruptFromAwaitingOther = interruptWith(buildInterruptPlan('awaiting', 'caller'))
const yieldTimerInterruptFromAwaiting = interruptWith(buildInterruptPlan('awaiting', 'yield_timer'))

function buildTurnIdentityContext(input: TurnActorInput) {
	return {
		input,
		clock: input.clock,
		turnId: input.turnId,
		userTranscript: input.userTranscript,
		generationStartedAt: input.generationStartedAt,
		lastTurnCompleteAt: input.lastTurnCompleteAt,
		lastVadSpeechEndAt: input.callerVadEndAt,
		callerVadEndAt: input.callerVadEndAt,
	}
}

function buildTurnRuntimeCore() {
	return {
		agentResponse: '',
		draftResponse: '',
		endCallRequested: false,
		holdRequested: false,
		committed: null,
		interruptReason: null,
		computedInterruptContext: null as InterruptContext | null,
		discardReason: null,
		abort: null,
		pausedAt: 0,
		softPauseSource: 'unknown' as SoftPauseSource,
		pauseTranscript: '',
		pauseFluxEvidence: false,
		resumedOverTranscript: '',
		vadSpeechStartAt: 0,
	}
}

function buildTurnRuntimePlayback() {
	return {
		firstAudioAt: null as number | null,
		draftMs: 0,
		ttsFirstByteMs: null as number | null,
		ttftMs: null as number | null,
		ttcMs: null as number | null,
	}
}

function buildTurnRuntimeContext() {
	return { ...buildTurnRuntimeCore(), ...buildTurnRuntimePlayback() }
}

function buildStrategyContext(input: TurnActorInput) {
	return {
		timingKind: strategyToTimingKind(input.strategy),
	}
}

function buildInitialContext(input: TurnActorInput) {
	const context = {
		...buildTurnIdentityContext(input),
		...buildTurnRuntimeContext(),
		...buildStrategyContext(input),
	} satisfies TurnActorContext
	return context
}

function buildCommitIdentity(context: TurnActorContext) {
	return {
		turnId: context.turnId,
		userTranscript: context.userTranscript,
		agentResponse: context.agentResponse,
		endCallRequested: context.endCallRequested,
		holdRequested: context.holdRequested,
		generationStartedAt: context.generationStartedAt,
	}
}

function buildCommitPlayback(context: TurnActorContext) {
	return {
		generationToAudioCompleteMs: context.draftMs,
		firstAudioAt: context.firstAudioAt,
		ttsFirstByteMs: context.ttsFirstByteMs,
		llmFirstTokenMs: context.ttftMs,
		llmCompleteMs: context.ttcMs,
	}
}

function buildCommitTiming(context: TurnActorContext) {
	return {
		timingKind: context.timingKind,
		lastTurnCompleteAt: context.lastTurnCompleteAt,
		lastVadSpeechEndAt: context.callerVadEndAt,
		deps: context.input.commitDeps,
	}
}

function commitActorInput(context: TurnActorContext) {
	return { ...buildCommitIdentity(context), ...buildCommitPlayback(context), ...buildCommitTiming(context) }
}

function setCommitOutput(event: unknown) {
	const output = (event as { output: { committedTurn: CommittedTurn } | null }).output
	if (output) return { committed: output.committedTurn, discardReason: null } as const
	return { committed: null, discardReason: 'commit_error' } as const
}

function buildCommittedOutcome(context: TurnActorContext) {
	return {
		kind: 'committed',
		turnId: context.turnId,
		turn: context.committed!,
		interruptContext: null,
	} as const
}

function buildInterruptedOutcome(context: TurnActorContext) {
	return {
		kind: 'interrupted',
		turnId: context.turnId,
		transcript: context.userTranscript,
		interruptContext: context.computedInterruptContext ?? {
			fullDraft: context.draftResponse,
			sentMs: 0,
			playedMs: 0,
			heardPortion: '',
		},
		reason: context.interruptReason!,
	} as const
}

function buildDiscardedOutcome(context: TurnActorContext) {
	return { kind: 'discarded', turnId: context.turnId, reason: context.discardReason ?? 'failed' } as const
}

function buildOutput(context: TurnActorContext) {
	if (context.committed) return buildCommittedOutcome(context)
	if (context.interruptReason) return buildInterruptedOutcome(context)
	return buildDiscardedOutcome(context)
}

export const turnActorMachine = turnActorSetup.createMachine({
	id: 'turnActor',
	initial: 'executing',
	context: ({ input }) => buildInitialContext(input),
	states: {
		executing: {
			entry: ['resetPauseState', turnActorSetup.assign({ abort: () => new AbortController() })],
			invoke: {
				id: 'runTurnPipeline',
				src: 'runTurnPipeline',
				input: ({ context }): RunTurnActorInput => ({
					strategy: context.input.strategy,
					turnId: context.turnId,
					signal: context.abort!.signal,
					generationAbort: context.abort!,
					generationStartedAt: context.generationStartedAt,
					clock: context.clock,
					deps: context.input.runTurnDeps,
				}),
			},
			initial: 'generating',
			states: {
				generating: {
					on: {
						audio_started: { target: 'streaming', actions: assignOnAudioStarted },
						first_audio_sent: { actions: assignOnFirstAudioSent },
						stream_done: { target: '#turnActor.awaitingPlayback', actions: assignOnStreamDone },
						interrupt: { target: '#turnActor.done', actions: interruptFromGenerating },
					},
				},
				streaming: {
					initial: 'flowing',
					states: {
						flowing: {
							on: { vad_speech_start: { target: 'yielding', actions: assignVadSpeechStart } },
						},
						yielding: {
							after: {
								yieldWindowMs: { target: '#turnActor.executing.softPaused', actions: enterSoftPause('yield_timer') },
							},
							on: {
								vad_speech_end: {
									target: 'flowing',
									actions: [assignVadSpeechEnd, clearVadSpeechStart],
								},
							},
						},
					},
					on: {
						first_audio_sent: { actions: assignOnFirstAudioSent },
						stream_done: { target: '#turnActor.awaitingPlayback', actions: assignOnStreamDone },
						caller_turn_start: {
							target: 'softPaused',
							actions: [enterSoftPause('deepgram_turn_start'), notePauseEvidence],
						},
						// A backchannel resume is provisional: the moment the same
						// utterance grows past the acknowledgement, yield.
						caller_update: {
							guard: 'resumedUtteranceGrewIntoSpeech',
							target: '#turnActor.done',
							actions: [revokeResume, interruptFromRevokedResume],
						},
						caller_turn_resumed: {
							guard: 'resumedUtteranceGrewIntoSpeech',
							target: '#turnActor.done',
							actions: [revokeResume, interruptFromRevokedResume],
						},
						interrupt: { target: '#turnActor.done', actions: interruptFromStreaming },
					},
				},
				// Soft pause: audio is held while we work out whether the caller
				// wants the floor. VAD opened the pause; the transcriber decides
				// how it ends.
				//
				//   probing   wait `substantiveSpeechMs`, collecting transcriber text
				//   deciding  transient: backchannel → resume (revocable: later
				//             interims that grow past it yield), words → interrupt,
				//             no words yet → vadOnly
				//   vadOnly   VAD still active but no words: give the transcriber
				//             `vadOnlyGraceMs` more; still nothing → noise, resume
				softPaused: {
					initial: 'probing',
					states: {
						probing: {
							after: { substantiveSpeechMs: { target: 'deciding' } },
							on: {
								caller_update: { actions: notePauseEvidence },
								caller_turn_start: { actions: notePauseEvidence },
								// Flux TurnResumed confirms the caller is still mid-utterance.
								// Reenter to rearm the substantiveSpeechMs timer — without this
								// the timer could fire even though Flux just told us the caller
								// is actively speaking.
								caller_turn_resumed: { target: 'probing', reenter: true, actions: notePauseEvidence },
							},
						},
						deciding: {
							always: [
								{
									guard: 'pauseIsBackchannel',
									target: '#turnActor.executing.resuming',
									actions: resumeFromBackchannel,
								},
								{ guard: 'pauseIsSpeech', target: '#turnActor.done', actions: interruptFromSubstantiveTimeout },
								{ target: 'vadOnly' },
							],
						},
						vadOnly: {
							after: { vadOnlyGraceMs: { target: '#turnActor.executing.resuming', actions: resumeFromVadOnly } },
							on: {
								caller_update: { target: 'deciding', actions: notePauseEvidence },
								caller_turn_start: { target: 'deciding', actions: notePauseEvidence },
								caller_turn_resumed: { target: 'deciding', actions: notePauseEvidence },
							},
						},
					},
					on: {
						vad_speech_end: { target: 'resuming', actions: resumeFromSoftPause },
						stream_done: { actions: assignStreamDoneWhilePaused },
						stream_empty: {
							target: '#turnActor.done',
							actions: [
								recordSoftPauseMetrics('interrupted'),
								turnActorSetup.assign({ discardReason: 'empty_response' }),
							],
						},
						stream_error: {
							target: '#turnActor.done',
							actions: [recordSoftPauseMetrics('interrupted'), turnActorSetup.assign({ discardReason: 'failed' })],
						},
						interrupt: { target: '#turnActor.done', actions: interruptFromSoftPaused },
					},
				},
				// Transient: where a resumed pause lands depends on whether the
				// pipeline finished while we were paused.
				resuming: {
					always: [
						{ guard: 'hasDraftFinished', target: '#turnActor.awaitingPlayback' },
						{ target: 'streaming.flowing' },
					],
				},
			},
			on: {
				stream_empty: { target: 'done', actions: turnActorSetup.assign({ discardReason: 'empty_response' }) },
				stream_error: { target: 'done', actions: turnActorSetup.assign({ discardReason: 'failed' }) },
			},
		},
		awaitingPlayback: {
			id: 'awaitingPlayback',
			entry: ['onPlaybackComplete', turnActorSetup.assign({ abort: null })],
			invoke: { id: 'playbackWait', src: 'playbackWait', input: {} },
			initial: 'waiting',
			states: {
				waiting: {
					after: {
						playbackTimeoutMs: { actions: sendTo('playbackWait', { type: 'playback_confirmed' }) },
					},
					on: { vad_speech_start: { target: 'vadActive', actions: assignVadSpeechStart } },
				},
				vadActive: {
					after: { yieldWindowMs: { target: '#turnActor.done', actions: yieldTimerInterruptFromAwaiting } },
					on: {
						vad_speech_end: {
							target: 'waiting',
							actions: [assignVadSpeechEnd, clearVadSpeechStart],
						},
					},
				},
			},
			on: {
				playback_settled: { target: 'committing' },
				playback_confirmed: { actions: sendTo('playbackWait', { type: 'playback_confirmed' }) },
				// A new Flux turn: the utterance we resumed over is finished.
				caller_turn_start: {
					actions: [
						turnActorSetup.assign({ resumedOverTranscript: '' }),
						sendTo('playbackWait', { type: 'caller_turn_start' }),
					],
				},
				caller_update: {
					guard: 'resumedUtteranceGrewIntoSpeech',
					target: 'done',
					actions: [revokeResume, interruptFromRevokedResumeAwaiting],
				},
				caller_turn_resumed: {
					guard: 'resumedUtteranceGrewIntoSpeech',
					target: 'done',
					actions: [revokeResume, interruptFromRevokedResumeAwaiting],
				},
				interrupt: [
					{ guard: 'isCallEnded', target: 'done', actions: interruptFromAwaitingCallEnded },
					{ target: 'done', actions: interruptFromAwaitingOther },
				],
			},
		},
		committing: {
			invoke: {
				id: 'commitActor',
				src: 'commitActor',
				input: ({ context }) => commitActorInput(context),
				onDone: {
					target: 'done',
					actions: turnActorSetup.assign({
						committed: ({ event }) => setCommitOutput(event).committed,
						discardReason: ({ event }) => setCommitOutput(event).discardReason,
					}),
				},
				onError: { target: 'done', actions: turnActorSetup.assign({ discardReason: 'commit_error' }) },
			},
		},
		done: { type: 'final' },
	},
	output: ({ context }) => buildOutput(context),
})

export { commitActorLogic, playbackWaitActor, runTurnActorLogic }
export type { CommitActorDeps, RunTurnActorDeps, RunTurnActorInput, RunTurnStrategyInput, StreamResult }

export type TurnActorMachine = typeof turnActorMachine
export type TurnActorSnapshot = SnapshotFrom<TurnActorMachine>
export type TurnActorStateValue = Parameters<TurnActorSnapshot['matches']>[0]
