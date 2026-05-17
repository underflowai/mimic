/**
 * Backchannel Engine
 *
 * Event-driven actor that decides if/when to fire short acknowledgement
 * tokens ("mm-hmm", "right", "yeah") during caller speech.
 *
 * Inputs:
 *   - caller_turn_event (from transcriber/runtime)
 *   - turn_outcome (from CallMachine)
 *
 * Output:
 *   - deps.onFire(token)
 */

import { createLogger } from '#engine/logger.js'
import { createActor, fromPromise, setup, type DoneActorEvent, type ErrorActorEvent } from 'xstate'

import type { BackchannelCallerTurnEvent, BackchannelTurnOutcome } from './types.js'

const log = createLogger('mimic:bc-engine')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackchannelToken = 'mm-hmm' | 'right' | 'yeah' | 'got-it' | 'okay' | 'uh-huh' | 'sure' | 'i-see'

export interface BackchannelEngineDeps {
	onFire: (token: BackchannelToken) => void
	classifyBackchannel: (transcript: string) => Promise<BackchannelToken | null>
	nowMs?: () => number
}

export interface BackchannelEngineConfig {
	minSpeechGateMs?: number
	refractoryMs?: number
	minWordCount?: number
	eotConfidenceThreshold?: number
	postInterruptSuppressionMs?: number
}

interface BackchannelContext {
	speechStartedAt: number
	lastFireAt: number
	lastTranscript: string
	lastEotConfidence: number
	classifyingTranscript: string
	pendingClassifyingTranscript: string
}

type BackchannelEvent =
	| { type: 'caller_turn_event'; event: BackchannelCallerTurnEvent }
	| { type: 'turn_outcome'; outcome: BackchannelTurnOutcome }
	| { type: 'reset' }

type BackchannelInternalEvent = DoneActorEvent<BackchannelToken | null, string> | ErrorActorEvent<unknown, string>

// ---------------------------------------------------------------------------
// Backchannel Engine
// ---------------------------------------------------------------------------

export function createBackchannelEngine(deps: BackchannelEngineDeps, config?: BackchannelEngineConfig) {
	const minSpeechGateMs = config?.minSpeechGateMs ?? 3000
	const refractoryMs = config?.refractoryMs ?? 4000
	const minWordCount = config?.minWordCount ?? 4
	const eotConfidenceThreshold = config?.eotConfidenceThreshold ?? 0.35
	const postInterruptSuppressionMs = config?.postInterruptSuppressionMs ?? 200
	const nowMs = deps.nowMs ?? Date.now
	let classifierFailures = 0

	function passesGates(context: BackchannelContext, transcript: string, eotConfidence: number) {
		const now = nowMs()
		if (context.speechStartedAt === 0) return false
		if (now - context.speechStartedAt < minSpeechGateMs) return false
		if (context.lastFireAt > 0 && now - context.lastFireAt < refractoryMs) return false
		if (transcript.trim().split(/\s+/).length < minWordCount) return false
		if (eotConfidence >= eotConfidenceThreshold) return false
		return true
	}

	function isCallerTurnStart(event: BackchannelEvent | BackchannelInternalEvent) {
		return event.type === 'caller_turn_event' && event.event.type === 'turn_start'
	}

	function isCallerTurnUpdate(event: BackchannelEvent | BackchannelInternalEvent) {
		return event.type === 'caller_turn_event' && (event.event.type === 'update' || event.event.type === 'eager_turn')
	}

	function isCallerTurnEnded(event: BackchannelEvent | BackchannelInternalEvent) {
		if (event.type !== 'caller_turn_event') return false
		return event.event.type === 'turn_complete' || event.event.type === 'turn_resumed'
	}

	function isInterruptedOutcome(event: BackchannelEvent | BackchannelInternalEvent) {
		return event.type === 'turn_outcome' && event.outcome.kind === 'interrupted'
	}

	const backchannelSetup = setup({
		types: {
			context: {} as BackchannelContext,
			events: {} as BackchannelEvent | BackchannelInternalEvent,
		},
		actors: {
			classifyBackchannel: fromPromise(async ({ input }: { input: { transcript: string } }) => {
				return deps.classifyBackchannel(input.transcript)
			}),
		},
		guards: {
			isCallerTurnStart: ({ event }) => isCallerTurnStart(event),
			isCallerTurnUpdate: ({ event }) => isCallerTurnUpdate(event),
			isCallerTurnEnded: ({ event }) => isCallerTurnEnded(event),
			isInterruptedOutcome: ({ event }) => isInterruptedOutcome(event),
			shouldClassify: ({ context, event }) =>
				event.type === 'caller_turn_event' &&
				(event.event.type === 'update' || event.event.type === 'eager_turn') &&
				passesGates(context, event.event.transcript, event.event.confidence),
			hasPendingClassifyingTranscript: ({ context }) =>
				context.pendingClassifyingTranscript.trim().length > 0,
			shouldClassifyPendingTranscript: ({ context }) =>
				context.pendingClassifyingTranscript.trim().length > 0 &&
				passesGates(
					context,
					context.pendingClassifyingTranscript,
					context.lastEotConfidence,
				),
			shouldFireClassifierToken: ({ context, event }) => {
				if (!('output' in event)) return false
				const token = event.output as BackchannelToken | null
				if (!token) return false
				if (context.pendingClassifyingTranscript.trim().length > 0) return false
				return context.lastEotConfidence < eotConfidenceThreshold
			},
		},
		delays: {
			refractoryMs,
			postInterruptSuppressionMs,
		},
	})

	const assignUpdate = backchannelSetup.assign({
		lastTranscript: ({ context, event }) =>
			event.type === 'caller_turn_event' && (event.event.type === 'update' || event.event.type === 'eager_turn')
				? event.event.transcript
				: context.lastTranscript,
		lastEotConfidence: ({ context, event }) =>
			event.type === 'caller_turn_event' && (event.event.type === 'update' || event.event.type === 'eager_turn')
				? event.event.confidence
				: context.lastEotConfidence,
	})

	const assignSpeechStart = backchannelSetup.assign({
		speechStartedAt: ({ context }) => (context.speechStartedAt === 0 ? nowMs() : context.speechStartedAt),
	})

	const assignClassifyingTranscript = backchannelSetup.assign({
		classifyingTranscript: ({ context, event }) =>
			event.type === 'caller_turn_event' && (event.event.type === 'update' || event.event.type === 'eager_turn')
				? event.event.transcript
				: context.classifyingTranscript,
	})

	const assignPendingClassifyingTranscript = backchannelSetup.assign({
		pendingClassifyingTranscript: ({ context, event }) =>
			event.type === 'caller_turn_event' && (event.event.type === 'update' || event.event.type === 'eager_turn')
				? event.event.transcript
				: context.pendingClassifyingTranscript,
	})

	const promotePendingClassifyingTranscript = backchannelSetup.assign({
		classifyingTranscript: ({ context }) => context.pendingClassifyingTranscript,
		pendingClassifyingTranscript: '',
	})

	const clearPendingClassifyingTranscript = backchannelSetup.assign({
		pendingClassifyingTranscript: '',
	})

	const resetSpeech = backchannelSetup.assign({
		speechStartedAt: 0,
		lastTranscript: '',
		lastEotConfidence: 0,
		classifyingTranscript: '',
		pendingClassifyingTranscript: '',
	})

	const applyClassifierResult = backchannelSetup.enqueueActions(({ context, event, enqueue }) => {
		if (!('output' in event)) return
		const token = event.output as BackchannelToken | null
		if (!token) return
		if (context.lastEotConfidence >= eotConfidenceThreshold) return
		const firedAt = nowMs()
		log.info({ token, eotConfidence: context.lastEotConfidence }, 'backchannel fired')
		deps.onFire(token)
		enqueue.assign({ lastFireAt: () => firedAt })
	})

	const backchannelMachine = backchannelSetup.createMachine({
		id: 'backchannel',
		initial: 'idle',
		context: {
			speechStartedAt: 0,
			lastFireAt: 0,
			lastTranscript: '',
			lastEotConfidence: 0,
			classifyingTranscript: '',
			pendingClassifyingTranscript: '',
		},
		on: {
			turn_outcome: [
				{
					guard: 'isInterruptedOutcome',
					target: '.postInterrupt',
					actions: resetSpeech,
				},
				{
					target: '.idle',
					actions: resetSpeech,
				},
			],
		},
		states: {
			idle: {
				on: {
					caller_turn_event: [
						{
							guard: 'isCallerTurnStart',
							target: 'listening',
							actions: assignSpeechStart,
						},
					],
				},
			},
			listening: {
				on: {
					caller_turn_event: [
						{
							guard: 'isCallerTurnEnded',
							target: 'idle',
							actions: resetSpeech,
						},
						{
							guard: 'shouldClassify',
							target: 'classifying',
							actions: [assignUpdate, assignClassifyingTranscript],
						},
						{
							guard: 'isCallerTurnUpdate',
							actions: assignUpdate,
						},
					],
				},
			},
			classifying: {
				invoke: {
					src: 'classifyBackchannel',
					input: ({ context }) => ({ transcript: context.classifyingTranscript }),
					onDone: [
						{
							guard: 'shouldClassifyPendingTranscript',
							target: 'classifying',
							reenter: true,
							actions: promotePendingClassifyingTranscript,
						},
						{
							guard: 'hasPendingClassifyingTranscript',
							target: 'listening',
							actions: clearPendingClassifyingTranscript,
						},
						{
							guard: 'shouldFireClassifierToken',
							target: 'refractory',
							actions: applyClassifierResult,
						},
						{
							target: 'listening',
							actions: clearPendingClassifyingTranscript,
						},
					],
					onError: [
						{
							guard: 'shouldClassifyPendingTranscript',
							target: 'classifying',
							reenter: true,
							actions: [
								({ event }) => {
									classifierFailures++
									log.warn({ err: (event as ErrorActorEvent<unknown, string>).error }, 'backchannel classifier failed')
								},
								promotePendingClassifyingTranscript,
							],
						},
						{
							target: 'listening',
							actions: [
								({ event }) => {
									classifierFailures++
									log.warn({ err: (event as ErrorActorEvent<unknown, string>).error }, 'backchannel classifier failed')
								},
								clearPendingClassifyingTranscript,
							],
						},
					],
				},
				on: {
					caller_turn_event: [
						{
							guard: 'isCallerTurnEnded',
							target: 'idle',
							actions: resetSpeech,
						},
						{
							guard: 'isCallerTurnUpdate',
							actions: [assignUpdate, assignPendingClassifyingTranscript],
						},
					],
				},
			},
			refractory: {
				on: {
					caller_turn_event: [
						{
							guard: 'isCallerTurnEnded',
							target: 'idle',
							actions: resetSpeech,
						},
						{
							guard: 'isCallerTurnUpdate',
							actions: assignUpdate,
						},
					],
				},
				after: {
					refractoryMs: { target: 'listening' },
				},
			},
			postInterrupt: {
				after: {
					postInterruptSuppressionMs: { target: 'idle' },
				},
			},
		},
	})

	const actor = createActor(backchannelMachine).start()

	return {
		send: actor.send,
		stop: actor.stop,
		getSnapshot: actor.getSnapshot,
		get classifierFailures() {
			return classifierFailures
		},
	}
}

export type BackchannelEngine = ReturnType<typeof createBackchannelEngine>
