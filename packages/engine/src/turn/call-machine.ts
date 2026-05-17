/**
 * CallMachine — call-scoped coordinator around TurnActor.
 */

import {
	raise,
	sendTo,
	setup,
	spawnChild,
	stopChild,
	type ActorRefFrom,
	type DoneActorEvent,
	type ErrorActorEvent,
	type SnapshotFrom,
} from 'xstate'

import { eagerMachine, type EagerMachineActor } from '../intelligence/eager-machine.js'
import { toolSupervisor, type ToolSupervisorActor } from '../intelligence/tools/supervisor-machine.js'
import { selectStrategy, type EagerStateValue, type TurnStrategy } from './strategy.js'
import {
	turnActorMachine,
	type CommitActorDeps,
	type RunTurnActorDeps,
	type TurnActorExecutionStrategy,
	type TurnActorMachine,
	type TurnActorSnapshot,
} from './turn-actor.js'
import type { InterruptReason, TurnOutcome } from './types.js'

export type { PlaybackWaitSendEvent } from './actors/playback-wait-actor.js'
export type {
	CommitActorDeps,
	RunTurnActorDeps,
	RunTurnActorInput,
	RunTurnStrategyInput,
	TurnActorExecutionStrategy,
	TurnActorInput,
	TurnActorMachine,
} from './turn-actor.js'
export type { InterruptReason } from './types.js'

/** Silence watchdog — fixed idle delay before each follow-up check. */
const silenceIdleMs = 6_000
/** Maximum number of silence follow-up turns before closing guidance is used. */
const maxSilenceFollowUps = 3

export interface PendingStrategy {
	strategy: TurnActorExecutionStrategy
	turnId: number
	userTranscript: string
	generationStartedAt: number
}

interface PendingTurnComplete {
	transcript: string
	confidence: number
	controlBlock: string
	agentLastResponse: string
}

export interface CallMachineContext {
	backchannelResumedPending: boolean
	callerActive: boolean
	lastTurnWasInterrupted: boolean
	lastVadSpeechEndAt: number
	lastTurnCompleteAt: number
	callerVadEndAt: number
	nextTurnId: number
	isClosing: boolean
	pendingStrategy: PendingStrategy | null
	pendingTurnComplete: PendingTurnComplete | null
	pendingSilenceClosing: boolean
	silenceFollowUpCount: number
	runTurnDeps: RunTurnActorDeps | null
	commitDeps: CommitActorDeps | null
	getAudioSenderSnapshot: (() => { sentMs: number; confirmedWordsPlayed: number }) | null
}

export interface CallMachineInput {
	runTurnDeps: RunTurnActorDeps
	commitDeps: CommitActorDeps
	getAudioSenderSnapshot: () => { sentMs: number; confirmedWordsPlayed: number }
}

type TurnCompleteEvent = {
	type: 'turn_complete'
	transcript: string
	confidence: number
	controlBlock: string
	agentLastResponse: string
}

type CallEvent =
	| TurnCompleteEvent
	| { type: 'start_first_turn'; openingBlock: string }
	| { type: 'interrupt'; reason: InterruptReason }
	| { type: 'caller_turn_start' }
	| { type: 'caller_update'; transcript: string; confidence: number }
	| { type: 'caller_eager_turn'; transcript: string; confidence: number }
	| { type: 'caller_turn_complete'; transcript: string; confidence: number }
	| { type: 'caller_turn_resumed'; transcript: string }
	| { type: 'playback_confirmed' }
	| { type: 'vad_speech_start' }
	| { type: 'vad_speech_end' }
	| { type: 'tool_result_ready'; toolName: string; result: string }
	| { type: 'transcriber_error'; message: string }
	| {
			type: 'eager_promotion_metrics'
			outcome: 'promoted' | 'discarded_diverged'
			specTranscript: string
			finalTranscript: string
			durationMs: number
	  }
	| { type: 'allocate_turn_id' }
	| { type: 'close' }
	| { type: 'promotion_resolved'; promoted: boolean }
	| { type: 'reset_idle' }
	| { type: 'restart_turn_actor' }
	| { type: 'cancel_eager_from_turn' }
	| { type: 'tool_intent_resolved'; turnId: number; needsTool: boolean }
	| { type: 'tool_awaiting_args'; turnId: number; taskId: number; toolName: string; missingArgs: string[] }

type CallInternalEvent = DoneActorEvent<TurnOutcome, string> | ErrorActorEvent<unknown, string>

type DispatchResult =
	| {
			kind: 'emit'
			outcome: TurnOutcome
			commitUserOnly?: string
			interruptActive?: InterruptReason
	  }
	| { kind: 'start'; pending: PendingStrategy }
	| { kind: 'interrupt-active'; pending: PendingTurnComplete }

type DispatchParams = {
	mode: 'idle' | 'inTurn'
	context: CallMachineContext
	event: TurnCompleteEvent
	snapshot: { children: Record<string, unknown> }
	turnActorSnapshot: TurnActorSnapshot | null
}

type IdleDispatchParams = DispatchParams & { mode: 'idle' }

const callMachineSetup = setup({
	types: {
		context: {} as CallMachineContext,
		input: {} as CallMachineInput,
		events: {} as CallEvent | CallInternalEvent,
		emitted: {} as { type: 'turn_outcome'; outcome: TurnOutcome },
	},
	actors: {
		eagerPipeline: eagerMachine,
		turnActor: turnActorMachine,
		toolPipeline: toolSupervisor,
	},
	actions: {
		onEagerPromotionMetrics: (
			_,
			_params: {
				outcome: 'promoted' | 'discarded_diverged'
				specTranscript: string
				finalTranscript: string
				durationMs: number
			},
		) => {},
		triggerEagerTurn: (_, _params: { transcript: string; confidence: number }) => {},
		completeCallerTurn: (_, _params: { transcript: string; confidence: number }) => {},
		markEagerTurnResumed: () => {},
		cancelEager: () => {},
		commitUserOnly: (_, _params: { userTranscript: string }) => {},
		recordTurnOutcomeMetric: (_, _params: { outcome: TurnOutcome }) => {},
		requestSilenceFollowUp: (_, _params: { silenceFollowUpCount: number; silenceClosing: boolean }) => {},
		requestCallHangup: (_, _params: { source: 'silence' | 'end_call_tag' }) => {},
		onTranscriberError: (_, _params: { message: string }) => {},
		commitToolResultToDirector: (_, _params: { toolName: string; result: string }) => {},
	},
	delays: {
		silenceIdleMs,
	},
	guards: {
		isInterruptedOutcome: ({ event }) => extractDoneOutcome(event).kind === 'interrupted',
		isMeaningfulCallerUpdate: ({ context, event }) =>
			!context.isClosing && event.type === 'caller_update' && event.transcript.trim().length > 0,
		hasFreshTurnSentAudio: () => false,
	},
})

function extractDoneOutcome(event: unknown) {
	return (event as { output: TurnOutcome }).output
}

function asTurnComplete(event: CallEvent | CallInternalEvent) {
	return event.type === 'turn_complete' ? event : null
}

function toExecutionStrategy(strategy: TurnStrategy) {
	if (strategy.kind === 'discard' || strategy.kind === 'defer') return null
	return strategy
}

function isTerminalStrategy(strategy: TurnStrategy) {
	return strategy.kind === 'discard' || strategy.kind === 'defer'
}

function buildOutcomeFromStrategy(strategy: TurnStrategy, turnId: number) {
	if (strategy.kind === 'discard') return { kind: 'discarded', turnId, reason: strategy.reason } as const
	return { kind: 'deferred', turnId, reason: 'soft_paused' } as const
}

function buildPendingTurnState(strategy: TurnActorExecutionStrategy, event: TurnCompleteEvent, turnId: number) {
	return {
		strategy,
		turnId,
		userTranscript: event.transcript,
		generationStartedAt: Date.now(),
	}
}

function isRacingPromotionStrategy(
	strategy: TurnActorExecutionStrategy,
): strategy is Extract<TurnActorExecutionStrategy, { kind: 'fresh'; racingPromotion?: boolean }> {
	return strategy.kind === 'fresh' && strategy.racingPromotion === true
}

function freshTurnHasSentAudio(snapshot: TurnActorSnapshot | null) {
	if (!snapshot) return false
	if (snapshot.context.firstAudioAt !== null) return true
	return !matchTurnActorState(snapshot, 'executing.generating')
}

function buildPromotedEagerStrategy(
	eagerActor: EagerMachineActor | undefined,
	userTranscript: string,
): Extract<TurnActorExecutionStrategy, { kind: 'presynthesized' }> | null {
	if (!eagerActor) return null
	const eagerSnapshot = eagerActor.getSnapshot()
	if (eagerSnapshot.value !== 'ready') return null
	const eagerDraft = eagerSnapshot.context.eagerDraft
	const sink = eagerSnapshot.context.sink
	if (!eagerDraft || !sink) return null
	return {
		kind: 'presynthesized',
		transcript: userTranscript,
		agentResponse: eagerDraft.agentResponse,
		sink,
		ttsPromise: eagerSnapshot.context.ttsPromise,
		triggerSynthesisStart: eagerSnapshot.context.triggerSynthesisStart,
		generationStartedAt: eagerSnapshot.context.eagerStartedAt,
	}
}

function buildPendingTurnComplete(event: TurnCompleteEvent): PendingTurnComplete {
	return {
		transcript: event.transcript,
		confidence: event.confidence,
		controlBlock: event.controlBlock,
		agentLastResponse: event.agentLastResponse,
	}
}

type CallEnqueue = Parameters<Parameters<(typeof callMachineSetup)['enqueueActions']>[0]>[0]['enqueue']

function emitOutcome(enqueue: CallEnqueue, outcome: TurnOutcome) {
	enqueue.emit({ type: 'turn_outcome', outcome })
	enqueue({ type: 'recordTurnOutcomeMetric', params: { outcome } })
}

function maybeClosingCommit(context: CallMachineContext, event: TurnCompleteEvent) {
	if (!context.isClosing) return undefined
	const trimmed = event.transcript.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

function parseEagerStateValue(value: unknown) {
	return typeof value === 'string' ? (value as EagerStateValue) : null
}

function buildEagerContext(snap: ReturnType<EagerMachineActor['getSnapshot']>) {
	return {
		turnId: snap.context.turnId,
		eagerDraft: snap.context.eagerDraft,
		eagerGeneratedAt: snap.context.eagerGeneratedAt,
		sink: snap.context.sink,
		ttsPromise: snap.context.ttsPromise,
		triggerSynthesisStart: snap.context.triggerSynthesisStart,
		eagerStartedAt: snap.context.eagerStartedAt,
		validatedTranscript: snap.context.validatedTranscript,
		turnResumedSince: snap.context.turnResumedSince,
	}
}

function buildEagerSnapshot(actor: EagerMachineActor | undefined) {
	if (!actor) return null
	const snap = actor.getSnapshot()
	const value = parseEagerStateValue(snap.value)
	if (!value) return null
	return { value, context: buildEagerContext(snap) }
}

function getEagerActor(snapshot: { children: Record<string, unknown> }) {
	return snapshot.children['eager-pipeline'] as EagerMachineActor | undefined
}

function buildWorldSnapshot(
	context: CallMachineContext,
	snapshot: { children: Record<string, unknown> },
	inSoftPause: boolean,
) {
	const eager = buildEagerSnapshot(getEagerActor(snapshot))
	return {
		isClosing: context.isClosing,
		inSoftPause,
		backchannelResumedPending: context.backchannelResumedPending,
		lastTurnWasInterrupted: context.lastTurnWasInterrupted,
		eagerSnapshot: eager,
	}
}

function splitPath(path: string) {
	return path.split('.').filter(Boolean)
}

function matchesPath(value: unknown, parts: string[]) {
	if (parts.length === 0) return true
	if (typeof value === 'string') return parts.length === 1 && value === parts[0]
	if (!value || typeof value !== 'object') return false
	const [head, ...tail] = parts
	const node = value as Record<string, unknown>
	if (!(head in node)) return false
	return matchesPath(node[head], tail)
}

function matchTurnActorState(snapshot: TurnActorSnapshot, path: string) {
	return matchesPath(snapshot.value, splitPath(path))
}

function isTurnActorSoftPaused(snapshot: TurnActorSnapshot | null) {
	return snapshot ? matchTurnActorState(snapshot, 'executing.softPaused') : false
}

function terminalOutcomeFromPriority(
	context: CallMachineContext,
	turnId: number,
	turnActorSnapshot: TurnActorSnapshot | null,
) {
	if (context.isClosing) return { kind: 'discarded', turnId, reason: 'closing' } as const
	if (context.backchannelResumedPending) return { kind: 'discarded', turnId, reason: 'backchannel_handled' } as const
	if (isTurnActorSoftPaused(turnActorSnapshot)) return { kind: 'deferred', turnId, reason: 'soft_paused' } as const
	return null
}

function dispatchIdleTurnComplete(params: IdleDispatchParams, turnId: number) {
	const world = buildWorldSnapshot(params.context, params.snapshot, false)
	const strategy = selectStrategy(
		{
			transcript: params.event.transcript,
			confidence: params.event.confidence,
			controlBlock: params.event.controlBlock,
		},
		world,
	)
	if (isTerminalStrategy(strategy))
		return { kind: 'emit', outcome: buildOutcomeFromStrategy(strategy, turnId) } satisfies DispatchResult
	const execution = toExecutionStrategy(strategy)
	if (!execution)
		return { kind: 'emit', outcome: { kind: 'discarded', turnId, reason: 'failed' } } satisfies DispatchResult
	return { kind: 'start', pending: buildPendingTurnState(execution, params.event, turnId) } satisfies DispatchResult
}

function dispatchTurnComplete(params: DispatchParams) {
	const turnId = params.context.nextTurnId
	const terminal = terminalOutcomeFromPriority(params.context, turnId, params.turnActorSnapshot)
	if (terminal) {
		const interruptActive =
			params.mode === 'inTurn' && terminal.kind === 'discarded' && terminal.reason === 'closing'
				? ('call_ended' as InterruptReason)
				: undefined
		return {
			kind: 'emit',
			outcome: terminal,
			commitUserOnly: maybeClosingCommit(params.context, params.event),
			interruptActive,
		} satisfies DispatchResult
	}
	if (params.mode === 'inTurn')
		return { kind: 'interrupt-active', pending: buildPendingTurnComplete(params.event) } satisfies DispatchResult
	return dispatchIdleTurnComplete({ ...params, mode: 'idle' }, turnId)
}

function applyDispatch(enqueue: CallEnqueue, dispatch: DispatchResult) {
	if (dispatch.kind === 'emit') return applyEmitDispatch(enqueue, dispatch)
	if (dispatch.kind === 'start') return applyStartDispatch(enqueue, dispatch)
	return applyInterruptDispatch(enqueue, dispatch)
}

function applyEmitDispatch(enqueue: CallEnqueue, dispatch: Extract<DispatchResult, { kind: 'emit' }>) {
	if (dispatch.commitUserOnly) enqueue({ type: 'commitUserOnly', params: { userTranscript: dispatch.commitUserOnly } })
	emitOutcome(enqueue, dispatch.outcome)
	if (dispatch.interruptActive) enqueue.sendTo('turnActor', { type: 'interrupt', reason: dispatch.interruptActive })
}

function applyStartDispatch(enqueue: CallEnqueue, dispatch: Extract<DispatchResult, { kind: 'start' }>) {
	const strategy = dispatch.pending.strategy
	const shouldKeepEager = strategy.kind === 'presynthesized' || isRacingPromotionStrategy(strategy)
	if (!shouldKeepEager) {
		enqueue('cancelEager')
	}
	if (isRacingPromotionStrategy(strategy)) {
		enqueue.sendTo('eager-pipeline', {
			type: 'FINAL_TURN_VALIDATE',
			transcript: strategy.transcript,
			controlBlock: strategy.controlBlock,
			turnId: dispatch.pending.turnId,
		})
	}
	enqueue.assign({
		lastTurnCompleteAt: () => Date.now(),
		callerVadEndAt: ({ context }: { context: CallMachineContext }) => context.lastVadSpeechEndAt,
	})
	enqueue.assign({ nextTurnId: ({ context }: { context: CallMachineContext }) => context.nextTurnId + 1 })
	enqueue.assign({ pendingSilenceClosing: false })
	enqueue.assign({ pendingStrategy: () => dispatch.pending })
	enqueue.assign({ silenceFollowUpCount: 0 })
	enqueue.raise({ type: 'reset_idle' })
}

function applyInterruptDispatch(enqueue: CallEnqueue, dispatch: Extract<DispatchResult, { kind: 'interrupt-active' }>) {
	enqueue.assign({ pendingTurnComplete: () => dispatch.pending })
	enqueue.assign({
		lastTurnCompleteAt: () => Date.now(),
		callerVadEndAt: ({ context }: { context: CallMachineContext }) => context.lastVadSpeechEndAt,
	})
	enqueue.sendTo('turnActor', { type: 'interrupt', reason: 'new_turn_started' })
}

function updateAfterTurnDone(_context: CallMachineContext, outcome: TurnOutcome) {
	return {
		pendingStrategy: null,
		pendingSilenceClosing: false,
		backchannelResumedPending: false,
		lastTurnWasInterrupted: outcome.kind === 'interrupted',
	}
}

function handleTurnDone(enqueue: CallEnqueue, context: CallMachineContext, raw: TurnOutcome) {
	emitOutcome(enqueue, raw)
	if (raw.kind === 'committed' && raw.turn.endCallRequested) {
		enqueue({ type: 'requestCallHangup', params: { source: 'end_call_tag' } })
	}
	if (context.pendingSilenceClosing && raw.kind === 'committed') {
		enqueue({ type: 'requestCallHangup', params: { source: 'silence' } })
	}
	enqueue.assign(updateAfterTurnDone(context, raw))
}

function raisePendingTurnComplete(enqueue: CallEnqueue, pending: PendingTurnComplete) {
	enqueue.raise({
		type: 'turn_complete',
		transcript: pending.transcript,
		confidence: pending.confidence,
		controlBlock: pending.controlBlock,
		agentLastResponse: pending.agentLastResponse,
	})
}

function hasPendingTurnComplete(context: CallMachineContext) {
	return context.pendingTurnComplete !== null
}

function turnActorInputFromContext(context: CallMachineContext) {
	if (!context.pendingStrategy) throw new Error('inTurn invoked without pendingStrategy')
	if (!context.runTurnDeps || !context.commitDeps) throw new Error('callMachine started without input deps')
	return {
		strategy: context.pendingStrategy.strategy,
		turnId: context.pendingStrategy.turnId,
		userTranscript: context.pendingStrategy.userTranscript,
		generationStartedAt: context.pendingStrategy.generationStartedAt,
		lastTurnCompleteAt: context.lastTurnCompleteAt,
		callerVadEndAt: context.callerVadEndAt,
		runTurnDeps: context.runTurnDeps,
		commitDeps: context.commitDeps,
		getAudioSenderSnapshot: context.getAudioSenderSnapshot ?? (() => ({ sentMs: 0, confirmedWordsPlayed: 0 })),
	}
}

function turnCompleteFromInterrupted(event: CallEvent | CallInternalEvent) {
	const e = asTurnComplete(event)
	if (e) return e
	return {
		type: 'turn_complete' as const,
		transcript: '',
		confidence: 0,
		controlBlock: '',
		agentLastResponse: '',
	}
}

// ── Shared caller-event handlers ─────────────────────────────────────
//
// These handlers are identical in `idle` and `interrupted`. Extracting
// them as named constants means a new caller-pipeline event only needs
// to be added once — the invariant "every caller event that idle handles,
// interrupted must also handle" is maintained by construction.

const callerUpdateHandler = {
	target: 'idle' as const,
	reenter: true,
	guard: 'isMeaningfulCallerUpdate' as const,
	actions: [callMachineSetup.assign({ callerActive: true, silenceFollowUpCount: 0 })],
}

const callerEagerTurnHandler = {
	target: 'idle' as const,
	reenter: true,
	guard: ({ context }: { context: CallMachineContext }) => !context.isClosing,
	actions: [
		callMachineSetup.assign({ callerActive: true }),
		{
			type: 'triggerEagerTurn' as const,
			params: ({ event }: { event: CallEvent | CallInternalEvent }) =>
				event.type === 'caller_eager_turn'
					? { transcript: event.transcript, confidence: event.confidence }
					: { transcript: '', confidence: 0 },
		},
	],
}

const callerTurnResumedHandler = {
	target: 'idle' as const,
	reenter: true,
	actions: ['markEagerTurnResumed' as const, callMachineSetup.assign({ callerActive: true, silenceFollowUpCount: 0 })],
}

const callerTurnStartHandler = {
	target: 'idle' as const,
	reenter: true,
	actions: ['cancelEager' as const, callMachineSetup.assign({ callerActive: true, silenceFollowUpCount: 0 })],
}

const callerTurnCompleteAction = {
	type: 'completeCallerTurn' as const,
	params: ({ event }: { event: CallEvent | CallInternalEvent }) =>
		event.type === 'caller_turn_complete'
			? { transcript: event.transcript, confidence: event.confidence }
			: { transcript: '', confidence: 0 },
}

export const callMachine = callMachineSetup.createMachine({
	id: 'call',
	initial: 'idle',
	entry: [
		spawnChild('eagerPipeline', { id: 'eager-pipeline' }),
		spawnChild('toolPipeline', { id: 'tool-pipeline', input: { tools: [] } }),
	],
	exit: [stopChild('eager-pipeline'), stopChild('tool-pipeline')],
	context: ({ input }): CallMachineContext => ({
		backchannelResumedPending: false,
		callerActive: false,
		lastTurnWasInterrupted: false,
		lastVadSpeechEndAt: 0,
		lastTurnCompleteAt: 0,
		callerVadEndAt: 0,
		nextTurnId: 0,
		isClosing: false,
		pendingStrategy: null,
		pendingTurnComplete: null,
		pendingSilenceClosing: false,
		silenceFollowUpCount: 0,
		runTurnDeps: input?.runTurnDeps ?? null,
		commitDeps: input?.commitDeps ?? null,
		getAudioSenderSnapshot: input?.getAudioSenderSnapshot ?? null,
	}),
	on: {
		allocate_turn_id: { actions: callMachineSetup.assign({ nextTurnId: ({ context }) => context.nextTurnId + 1 }) },
		close: { actions: ['cancelEager', callMachineSetup.assign({ isClosing: true })] },
		cancel_eager_from_turn: { actions: 'cancelEager' },
		eager_promotion_metrics: {
			actions: {
				type: 'onEagerPromotionMetrics',
				params: ({ event }) => ({
					outcome: event.outcome,
					specTranscript: event.specTranscript,
					finalTranscript: event.finalTranscript,
					durationMs: event.durationMs,
				}),
			},
		},
		vad_speech_start: {},
		vad_speech_end: { actions: callMachineSetup.assign({ lastVadSpeechEndAt: () => Date.now() }) },
		transcriber_error: {
			actions: {
				type: 'onTranscriberError',
				params: ({ event }) => (event.type === 'transcriber_error' ? { message: event.message } : { message: '' }),
			},
		},
		// Default promotion_resolved: cancel eager speculation. The inTurn
		// state overrides this with racing-promotion logic.
		promotion_resolved: { actions: 'cancelEager' },
	},
	states: {
		idle: {
			after: {
				silenceIdleMs: {
					guard: ({ context }) => context.nextTurnId > 0,
					actions: callMachineSetup.enqueueActions(({ context, enqueue }) => {
						const nextCount = context.silenceFollowUpCount + 1
						enqueue.assign({ silenceFollowUpCount: () => nextCount })
						if (nextCount > maxSilenceFollowUps) {
							enqueue({ type: 'requestCallHangup', params: { source: 'silence' } })
							return
						}
						enqueue({
							type: 'requestSilenceFollowUp',
							params: { silenceFollowUpCount: nextCount, silenceClosing: nextCount === maxSilenceFollowUps },
						})
					}),
				},
			},
			on: {
				tool_result_ready: {
					actions: [
						{
							type: 'commitToolResultToDirector',
							params: ({ event }) =>
								event.type === 'tool_result_ready'
									? { toolName: event.toolName, result: event.result }
									: { toolName: '', result: '' },
						},
					],
				},
				tool_intent_resolved: {},
				tool_awaiting_args: {},
				turn_complete: {
					actions: callMachineSetup.enqueueActions(({ context, event, enqueue, self }) => {
						const tc = asTurnComplete(event)
						if (!tc) return

						const dispatch = dispatchTurnComplete({
							mode: 'idle',
							context,
							event: tc,
							snapshot: self.getSnapshot(),
							turnActorSnapshot: null,
						})
						applyDispatch(enqueue, dispatch)
					}),
				},
				// Two-step dispatch: turn_complete assigns pendingStrategy then raises
				// reset_idle. XState processes the raise after the current transition
				// completes, so the machine is settled in idle with pendingStrategy
				// populated by the time this guard runs. The guard prevents spurious
				// transitions when reset_idle arrives without a pending strategy
				// (e.g. from the interrupted state).
				reset_idle: { target: 'inTurn', guard: ({ context }) => context.pendingStrategy !== null },
				start_first_turn: {
					target: 'inTurn',
					actions: callMachineSetup.enqueueActions(({ context, event, enqueue }) => {
						if (event.type !== 'start_first_turn') return
						enqueue.assign({
							pendingStrategy: () => ({
								strategy: { kind: 'first_turn', openingBlock: event.openingBlock },
								turnId: context.nextTurnId,
								userTranscript: '',
								generationStartedAt: Date.now(),
							}),
							pendingSilenceClosing: false,
						})
						enqueue.assign({ nextTurnId: () => context.nextTurnId + 1 })
					}),
				},
				caller_turn_start: callerTurnStartHandler,
				caller_update: callerUpdateHandler,
				caller_eager_turn: callerEagerTurnHandler,
				caller_turn_complete: {
					actions: [callMachineSetup.assign({ callerActive: false }), callerTurnCompleteAction],
				},
				// Flux `TurnResumed` is a high-confidence ML signal that the
				// caller is mid-utterance — reenter idle so the silence
				// watchdog's `after` timer is rearmed, and reset
				// silenceFollowUpCount the same way caller_turn_start does.
				caller_turn_resumed: callerTurnResumedHandler,
			},
		},
		inTurn: {
			invoke: {
				id: 'turnActor',
				src: 'turnActor',
				input: ({ context }) => turnActorInputFromContext(context),
				onDone: [
					{
						guard: ({ context }) => hasPendingTurnComplete(context),
						target: 'idle',
						actions: callMachineSetup.enqueueActions(({ context, event, enqueue }) => {
							handleTurnDone(enqueue, context, extractDoneOutcome(event))
							enqueue.assign({ callerActive: false })
							if (!context.pendingTurnComplete) return
							enqueue.assign({ pendingTurnComplete: null })
							raisePendingTurnComplete(enqueue, context.pendingTurnComplete)
						}),
					},
					{
						guard: 'isInterruptedOutcome',
						target: 'interrupted',
						actions: callMachineSetup.enqueueActions(({ context, event, enqueue }) => {
							handleTurnDone(enqueue, context, extractDoneOutcome(event))
							enqueue.assign({ callerActive: false })
						}),
					},
					{
						target: 'idle',
						actions: callMachineSetup.enqueueActions(({ context, event, enqueue }) => {
							handleTurnDone(enqueue, context, extractDoneOutcome(event))
							enqueue.assign({ callerActive: false })
						}),
					},
				],
				onError: {
					target: 'idle',
					actions: callMachineSetup.enqueueActions(({ context, enqueue }) => {
						const turnId = context.pendingStrategy?.turnId ?? 0
						const outcome: TurnOutcome = {
							kind: 'discarded',
							turnId,
							reason: 'failed',
						}
						emitOutcome(enqueue, outcome)
						enqueue.assign({ callerActive: false, pendingStrategy: null, pendingTurnComplete: null })
					}),
				},
			},
			on: {
				caller_turn_complete: {
					actions: [
						callMachineSetup.assign({ callerActive: false }),
						{
							type: 'completeCallerTurn',
							params: ({ event }) =>
								event.type === 'caller_turn_complete'
									? { transcript: event.transcript, confidence: event.confidence }
									: { transcript: '', confidence: 0 },
						},
					],
				},
				turn_complete: {
					actions: callMachineSetup.enqueueActions(({ context, event, enqueue, self }) => {
						const tc = asTurnComplete(event)
						if (!tc) return
						const actor = self.getSnapshot().children['turnActor'] as ActorRefFrom<TurnActorMachine> | undefined
						const turnActorSnapshot = actor ? actor.getSnapshot() : null
						const dispatch = dispatchTurnComplete({
							mode: 'inTurn',
							context,
							event: tc,
							snapshot: self.getSnapshot(),
							turnActorSnapshot,
						})
						applyDispatch(enqueue, dispatch)
					}),
				},
				promotion_resolved: {
					actions: callMachineSetup.enqueueActions(({ context, event, enqueue, self, check }) => {
						if (event.type !== 'promotion_resolved') return
						const current = context.pendingStrategy
						if (!current || !isRacingPromotionStrategy(current.strategy)) return
						if (!event.promoted) {
							enqueue('cancelEager')
							return
						}
						const snapshot = self.getSnapshot()
						const turnActor = snapshot.children['turnActor'] as ActorRefFrom<TurnActorMachine> | undefined
						const turnActorSnapshot = turnActor ? turnActor.getSnapshot() : null
						if (check('hasFreshTurnSentAudio') || freshTurnHasSentAudio(turnActorSnapshot)) {
							enqueue('cancelEager')
							return
						}
						const promoted = buildPromotedEagerStrategy(getEagerActor(snapshot), current.userTranscript)
						if (!promoted) {
							enqueue('cancelEager')
							return
						}
						enqueue.assign({
							pendingStrategy: () => ({
								...current,
								strategy: promoted,
							}),
						})
						enqueue.raise({ type: 'restart_turn_actor' })
					}),
				},
				restart_turn_actor: { target: 'inTurn', reenter: true },
				interrupt: {
					actions: sendTo('turnActor', ({ event }) =>
						event.type === 'interrupt'
							? { type: 'interrupt', reason: event.reason }
							: { type: 'interrupt', reason: 'call_ended' },
					),
				},
				caller_turn_start: {
					actions: [
						callMachineSetup.assign({ callerActive: true }),
						sendTo('turnActor', { type: 'caller_turn_start' }),
					],
				},
				caller_turn_resumed: {
					actions: [
						'markEagerTurnResumed',
						callMachineSetup.assign({ callerActive: true }),
						sendTo('turnActor', { type: 'caller_turn_resumed' }),
					],
				},
				playback_confirmed: { actions: sendTo('turnActor', { type: 'playback_confirmed' }) },
				vad_speech_start: { actions: sendTo('turnActor', { type: 'vad_speech_start' }) },
				vad_speech_end: {
					actions: [
						callMachineSetup.assign({ lastVadSpeechEndAt: () => Date.now() }),
						sendTo('turnActor', { type: 'vad_speech_end' }),
					],
				},
				tool_result_ready: {
					actions: [
						{
							type: 'commitToolResultToDirector',
							params: ({ event }) =>
								event.type === 'tool_result_ready'
									? { toolName: event.toolName, result: event.result }
									: { toolName: '', result: '' },
						},
					],
				},
				tool_intent_resolved: {},
				tool_awaiting_args: {},
			},
		},
		interrupted: {
			on: {
				reset_idle: { target: 'idle' },
				caller_turn_resumed: callerTurnResumedHandler,
				caller_turn_start: callerTurnStartHandler,
				caller_update: callerUpdateHandler,
				caller_eager_turn: callerEagerTurnHandler,
				caller_turn_complete: {
					target: 'idle',
					actions: [callMachineSetup.assign({ callerActive: false }), callerTurnCompleteAction],
				},
				turn_complete: {
					target: 'idle',
					actions: raise(({ event }) => turnCompleteFromInterrupted(event)),
				},
			},
		},
	},
})

export type CallMachine = typeof callMachine
export type CallMachineSnapshot = SnapshotFrom<typeof callMachine>

export function getTurnActorSnapshot(snapshot: CallMachineSnapshot) {
	const actor = snapshot.children['turnActor'] as ActorRefFrom<TurnActorMachine> | undefined
	return actor ? actor.getSnapshot() : null
}

export function getEagerChildSnapshot(snapshot: CallMachineSnapshot) {
	const actor = snapshot.children['eager-pipeline'] as EagerMachineActor | undefined
	return actor ? actor.getSnapshot() : null
}

export function getToolPipelineSnapshot(snapshot: CallMachineSnapshot) {
	const actor = snapshot.children['tool-pipeline'] as ToolSupervisorActor | undefined
	return actor ? actor.getSnapshot() : null
}

export { dispatchTurnComplete, matchTurnActorState }
