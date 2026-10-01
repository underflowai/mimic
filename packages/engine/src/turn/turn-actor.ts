/**
 * TurnActor — per-turn lifecycle machine.
 */

import { fromCallback, sendTo, setup, type DoneActorEvent, type ErrorActorEvent, type SnapshotFrom } from 'xstate'

import { config } from '#engine/config.js'
import { sanitizeForTranscript } from '../audio/tts-sanitizer.js'
import type { InterruptContext } from '../intelligence/types.js'
import { estimateHeardPortion } from '../shared/audio-pacing.js'
import { isFillerOrAssentOnly } from '../shared/filler-speech.js'
import type { SoftPauseOutcome, SoftPauseSource, TurnTiming } from '../shared/metrics.js'
import { commitActorLogic, type CommitActorDeps, type CommitActorOutput } from './actors/commit-actor.js'
import { playbackWaitActor } from './actors/playback-wait-actor.js'
import {
	runTurnActorLogic,
	type RunTurnActorDeps,
	type RunTurnActorEvent,
	type RunTurnActorInput,
	type RunTurnStrategyInput,
	type StreamResult,
} from './actors/run-turn-actor.js'
import type { CommittedTurn, InterruptReason, TurnOutcome } from './types.js'

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
	/** Adaptive-physics widening of the soft-pause escalation timer. */
	substantiveSpeechExtraMs?: number
	runTurnDeps: RunTurnActorDeps
	commitDeps: CommitActorDeps
	getAudioSenderSnapshot: () => { sentMs: number; confirmedWordsPlayed: number }
}

export interface TurnActorContext {
	input: TurnActorInput
	turnId: number
	userTranscript: string
	agentResponse: string
	draftResponse: string
	endCallRequested: boolean
	committed: CommittedTurn | null
	interruptReason: InterruptReason | null
	computedInterruptContext: InterruptContext | null
	discardReason: InterruptDiscardReason | null
	abort: AbortController | null
	pausedAt: number
	softPauseSource: SoftPauseSource
	/** Set when a long soft-pause triggered restart-don't-resume; the
	 * executing state re-invokes the pipeline with this strategy. */
	restartStrategy: RunTurnStrategyInput | null
	/** True once the turn restarted from a pause — stream events from the
	 * restart pipeline must not overwrite the original draft text. */
	restartedFromPause: boolean
	/** Latest Flux partial for the utterance that triggered the current soft-pause. */
	callerPartialTranscript: string
	/** Times the substantive-speech timer was rearmed because the partial was pure filler/assent. */
	fillerHoldCount: number
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
	| { type: 'caller_turn_start' }
	| { type: 'caller_turn_resumed' }
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
	return context.pausedAt > 0 ? Date.now() - context.pausedAt : 0
}

/** Maximum consecutive filler-only rearm cycles of the substantive-speech timer. */
const maxFillerHolds = 2

/**
 * Restart-don't-resume. Below this pause duration, resuming buffered audio
 * mid-sentence still sounds natural; past it, the conversational thread is
 * broken — discard the buffer and re-speak from the last sentence boundary.
 */
const restartPauseMs = 700

/** Spoken lead-in for restarted audio. Never committed to the transcript —
 * the original draft text is preserved through the restart. */
const restartConnective = 'So — as I was saying:'

/**
 * Text the restarted pipeline should speak, or null when a plain resume is
 * the better move (nothing heard yet, everything heard, or empty draft).
 * The heard portion is estimated from the playback tracker, then walked
 * back to the last sentence boundary so the restart begins cleanly.
 */
function computeRestartText(context: TurnActorContext): string | null {
	const fullDraft = sanitizeForTranscript(context.draftResponse)
	if (!fullDraft) return null
	const { sentMs, confirmedWordsPlayed } = context.input.getAudioSenderSnapshot()
	const heardPortion = estimateHeardPortion(fullDraft, sentMs, confirmedWordsPlayed)
	// Nothing heard: a resume already replays from the start (the whole
	// draft is still buffered) — no need to re-synthesize.
	if (!heardPortion) return null
	if (heardPortion.length >= fullDraft.length) return null

	let boundary = 0
	for (let i = heardPortion.length - 1; i >= 0; i--) {
		const c = fullDraft[i]
		if (c === '.' || c === '!' || c === '?') {
			boundary = i + 1
			break
		}
	}
	const remainder = fullDraft.slice(boundary).trim()
	if (!remainder) return null
	return `${restartConnective} ${remainder}`
}

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
		onSubstantiveSpeechTimeout: (_, _params: { vadSpeechStartAt: number }) => {},
		onFillerHold: (_, _params: { transcript: string; durationMs: number }) => {},
		recordShortResumedBarge: () => {},
		resetPauseState: () => {},
		flushPausedBuffer: () => {},
		/** Tear down the paused pipeline's audio path (restart-don't-resume):
		 * drop buffered frames and destroy the sink so the restarted pipeline
		 * starts on a clean transport sink. */
		discardActiveTurn: () => {},
	},
	delays: {
		substantiveSpeechMs: ({ context }) =>
			config.mimic.substantiveSpeechMs + (context.input.substantiveSpeechExtraMs ?? 0),
		yieldWindowMs: config.mimic.yieldWindowMs,
		playbackTimeoutMs: 5000,
	},
	guards: {
		isCallEnded: ({ event }) => isCallEndedInterrupt(event as TurnActorEvent),
		// Content-aware escalation: when the substantive-speech timer fires
		// but everything the caller has said during this pause is filler or
		// assent ("yeah", "mm-hmm okay"), they are backchanneling, not taking
		// the turn — hold the pause instead of interrupting. Capped so a
		// caller chanting assent cannot pin the agent in soft-pause forever.
		// An empty partial (ASR has not caught up) escalates as before.
		holdSoftPauseForFillerSpeech: ({ context }) =>
			context.fillerHoldCount < maxFillerHolds && isFillerOrAssentOnly(context.callerPartialTranscript),
		// Restart-don't-resume: past `restartPauseMs` of pause, resuming
		// buffered audio mid-sentence sounds broken — re-speak instead.
		// One restart per turn: after a restart the heard-portion estimate
		// no longer maps onto the original draft, so later pauses resume.
		shouldRestartFromPause: ({ context }) =>
			!context.restartedFromPause &&
			softPauseDurationMs(context) >= restartPauseMs &&
			computeRestartText(context) !== null,
	},
})

const assignOnAudioStarted = turnActorSetup.assign({
	// After a pause restart, the pipeline speaks connective + remainder —
	// the committed text must stay the original full draft.
	agentResponse: ({ context, event }) => {
		if (context.restartedFromPause) return context.agentResponse
		return event.type === 'audio_started' ? event.agentResponse : ''
	},
	draftResponse: ({ context, event }) => {
		if (context.restartedFromPause) return context.draftResponse
		return event.type === 'audio_started' ? event.agentResponse : ''
	},
	endCallRequested: ({ context, event }) => {
		if (context.restartedFromPause) return context.endCallRequested
		return event.type === 'audio_started' && event.endCallRequested === true
	},
})

const assignOnFirstAudioSent = turnActorSetup.assign({
	firstAudioAt: ({ context, event }) => (event.type === 'first_audio_sent' ? event.at : context.firstAudioAt),
})

const assignOnStreamDone = turnActorSetup.assign({
	// Restarted turns keep the original generation's timing and text; only
	// draftMs (total wall time) tracks the restarted pipeline.
	firstAudioAt: ({ context, event }) => {
		if (event.type !== 'stream_done') return null
		if (context.restartedFromPause && context.firstAudioAt !== null) return context.firstAudioAt
		return event.result.firstAudioAt
	},
	draftMs: ({ event }) => (event.type === 'stream_done' ? event.result.draftMs : 0),
	ttsFirstByteMs: ({ context, event }) => {
		if (event.type !== 'stream_done') return null
		if (context.restartedFromPause && context.ttsFirstByteMs !== null) return context.ttsFirstByteMs
		return event.result.ttsFirstByteMs
	},
	ttftMs: ({ context, event }) => {
		if (event.type !== 'stream_done') return null
		if (context.restartedFromPause && context.ttftMs !== null) return context.ttftMs
		return event.result.ttftMs
	},
	ttcMs: ({ context, event }) => {
		if (event.type !== 'stream_done') return null
		if (context.restartedFromPause && context.ttcMs !== null) return context.ttcMs
		return event.result.ttcMs
	},
	agentResponse: ({ context, event }) => {
		if (event.type !== 'stream_done') return context.agentResponse
		if (context.restartedFromPause) return context.agentResponse
		const result = event.result as StreamResultPayload
		return result.agentResponse || context.agentResponse
	},
	endCallRequested: ({ context, event }) => {
		if (context.restartedFromPause) return context.endCallRequested
		return event.type === 'stream_done' ? event.result.endCallRequested : context.endCallRequested
	},
})

const assignVadSpeechStart = turnActorSetup.assign({ vadSpeechStartAt: () => Date.now() })
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
		// Reset the partial transcript so the filler-hold guard only judges
		// speech from the utterance that triggered this pause.
		enqueue.assign({
			pausedAt: () => Date.now(),
			softPauseSource: source,
			callerPartialTranscript: '',
			fillerHoldCount: 0,
		})
	})
}

const holdSoftPauseForFiller = turnActorSetup.enqueueActions(({ context, enqueue }) => {
	enqueue({
		type: 'onFillerHold',
		params: { transcript: context.callerPartialTranscript, durationMs: softPauseDurationMs(context) },
	})
	enqueue.assign({ fillerHoldCount: ({ context: ctx }) => ctx.fillerHoldCount + 1 })
})

const resumeFromSoftPause = turnActorSetup.enqueueActions(({ enqueue }) => {
	enqueue('flushPausedBuffer')
	enqueue(recordSoftPauseMetrics('resumed'))
	enqueue('recordShortResumedBarge')
	enqueue.assign({
		pausedAt: 0,
		softPauseSource: 'unknown',
		lastVadSpeechEndAt: () => Date.now(),
	})
})

/**
 * Restart-don't-resume: tear down the paused pipeline (abort generation,
 * cut TTS, discard buffered audio and sink) and re-enter `executing` with a
 * fixed-text strategy speaking connective + remainder from the last
 * sentence boundary. The guard guarantees `computeRestartText` is non-null.
 */
const restartFromSoftPause = turnActorSetup.enqueueActions(({ context, enqueue }) => {
	const restartText = computeRestartText(context)!
	context.abort?.abort()
	enqueue('interruptTts')
	enqueue('discardActiveTurn')
	enqueue(recordSoftPauseMetrics('restarted'))
	enqueue.assign({
		restartStrategy: {
			kind: 'fixed_text',
			text: restartText,
			transcript: context.userTranscript,
		},
		restartedFromPause: true,
		abort: null,
		pausedAt: 0,
		softPauseSource: 'unknown',
		lastVadSpeechEndAt: () => Date.now(),
	})
})

const assignStreamDoneWhilePaused = turnActorSetup.enqueueActions(({ event, enqueue }) => {
	if (event.type === 'stream_done') enqueue(assignOnStreamDone)
})

type TurnEnqueue = Parameters<Parameters<(typeof turnActorSetup)['enqueueActions']>[0]>[0]['enqueue']

function maybeRecordTimeout(enqueue: TurnEnqueue, context: TurnActorContext, config: InterruptConfig) {
	if (!config.recordSubstantiveTimeout) return
	enqueue({ type: 'onSubstantiveSpeechTimeout', params: { vadSpeechStartAt: context.vadSpeechStartAt } })
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
	const { sentMs, confirmedWordsPlayed } = context.input.getAudioSenderSnapshot()
	const spokenDraft = sanitizeForTranscript(context.draftResponse)
	const heardPortion = estimateHeardPortion(spokenDraft, sentMs, confirmedWordsPlayed)
	const interruptCtx: InterruptContext = { fullDraft: spokenDraft, sentMs, heardPortion }
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

function applyInterruptAssign(
	enqueue: TurnEnqueue,
	_context: TurnActorContext,
	event: TurnActorEvent,
	config: InterruptConfig,
) {
	enqueue.assign({ interruptReason: config.reason ?? interruptReasonFrom(event, 'caller_started_speaking') })
	if (hasResource(config, 'abort')) enqueue.assign({ abort: null })
	if (config.clearVad !== false) enqueue.assign({ vadSpeechStartAt: 0 })
	if (hasResource(config, 'softPause')) enqueue.assign({ pausedAt: 0, softPauseSource: 'unknown' })
	if (config.clearDraft) enqueue.assign({ draftResponse: '' })
	void _context
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
		applyInterruptAssign(enqueue, context, event as TurnActorEvent, config)
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
const interruptFromSoftPaused = interruptWith(buildInterruptPlan('softPaused', 'caller'))
const interruptFromSubstantiveTimeout = interruptWith(buildInterruptPlan('softPaused', 'substantive_timeout'))
const interruptFromAwaitingCallEnded = interruptWith(buildInterruptPlan('awaiting', 'call_ended'))
const interruptFromAwaitingOther = interruptWith(buildInterruptPlan('awaiting', 'caller'))
const yieldTimerInterruptFromAwaiting = interruptWith(buildInterruptPlan('awaiting', 'yield_timer'))

function buildTurnIdentityContext(input: TurnActorInput) {
	return {
		input,
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
		committed: null,
		interruptReason: null,
		computedInterruptContext: null as InterruptContext | null,
		discardReason: null,
		abort: null,
		pausedAt: 0,
		softPauseSource: 'unknown' as SoftPauseSource,
		restartStrategy: null as RunTurnStrategyInput | null,
		restartedFromPause: false,
		callerPartialTranscript: '',
		fillerHoldCount: 0,
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
	on: {
		// Flux partials for the caller's current utterance — consulted by the
		// soft-pause filler-hold guard. Tracked machine-wide; entering a
		// soft-pause clears the field so the guard only judges speech from
		// the utterance that triggered the pause.
		caller_update: {
			actions: turnActorSetup.assign({
				callerPartialTranscript: ({ context, event }) =>
					event.type === 'caller_update' ? event.transcript : context.callerPartialTranscript,
			}),
		},
	},
	states: {
		executing: {
			entry: ['resetPauseState', turnActorSetup.assign({ abort: () => new AbortController() })],
			invoke: {
				id: 'runTurnPipeline',
				src: 'runTurnPipeline',
				input: ({ context }): RunTurnActorInput => ({
					// A pause restart re-enters executing with a fixed-text strategy.
					strategy: context.restartStrategy ?? context.input.strategy,
					turnId: context.turnId,
					signal: context.abort!.signal,
					generationAbort: context.abort!,
					generationStartedAt: context.generationStartedAt,
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
									actions: [turnActorSetup.assign({ lastVadSpeechEndAt: () => Date.now() }), clearVadSpeechStart],
								},
							},
						},
					},
					on: {
						first_audio_sent: { actions: assignOnFirstAudioSent },
						stream_done: { target: '#turnActor.awaitingPlayback', actions: assignOnStreamDone },
						caller_turn_start: { target: 'softPaused', actions: enterSoftPause('deepgram_turn_start') },
						interrupt: { target: '#turnActor.done', actions: interruptFromStreaming },
					},
				},
				softPaused: {
					after: {
						substantiveSpeechMs: [
							// Pure filler/assent so far ("yeah", "mm-hmm") — the caller is
							// backchanneling, not taking the turn. Rearm the timer and keep
							// the pause; vad_speech_end resumes playback as usual.
							{
								guard: 'holdSoftPauseForFillerSpeech',
								target: 'softPaused',
								reenter: true,
								actions: holdSoftPauseForFiller,
							},
							{ target: '#turnActor.done', actions: interruptFromSubstantiveTimeout },
						],
					},
					on: {
						// Flux TurnResumed confirms the caller is still mid-utterance.
						// Reenter to rearm the substantiveSpeechMs timer — without this
						// the timer could fire even though Flux just told us the caller
						// is actively speaking.
						caller_turn_resumed: { target: 'softPaused', reenter: true },
						vad_speech_end: [
							// Long pause: the thread is broken — discard the buffered
							// remainder and re-speak from the last sentence boundary.
							{
								guard: 'shouldRestartFromPause',
								target: '#turnActor.executing',
								reenter: true,
								actions: restartFromSoftPause,
							},
							{
								guard: ({ context }) => context.draftMs > 0,
								target: '#turnActor.awaitingPlayback',
								actions: [resumeFromSoftPause],
							},
							{ target: 'streaming.flowing', actions: resumeFromSoftPause },
						],
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
							actions: [turnActorSetup.assign({ lastVadSpeechEndAt: () => Date.now() }), clearVadSpeechStart],
						},
					},
				},
			},
			on: {
				playback_settled: { target: 'committing' },
				playback_confirmed: { actions: sendTo('playbackWait', { type: 'playback_confirmed' }) },
				caller_turn_start: { actions: sendTo('playbackWait', { type: 'caller_turn_start' }) },
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
