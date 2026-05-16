import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { createFakeAudioTransport } from '#test/support/fake-audio-transport.js'
import { waitForCondition } from '#test/support/wait-for-condition.js'
import { ttsFrameBytes } from '../shared/audio-pacing.js'
import { createCallMachineRuntime, type CallMachineRuntimeDeps, type TurnOutcome } from './call-machine-runtime.js'

function getEagerState(engine: ReturnType<typeof createCallMachineRuntime>) {
	const snap = engine.actor.getSnapshot()
	const eager = snap.children['eager-pipeline'] as
		| { getSnapshot: () => { value: unknown; context: Record<string, unknown> } }
		| undefined
	if (!eager) return null
	const es = eager.getSnapshot()
	return {
		value: String(es.value),
		eagerDraft: es.context.eagerDraft as { agentResponse: string; userTranscript: string } | null,
		validatedTranscript: es.context.validatedTranscript as string | null,
	}
}

function waitForOutcome(engine: ReturnType<typeof createCallMachineRuntime>, turnId: number) {
	return new Promise<TurnOutcome>((resolve) => {
		const sub = engine.actor.on('turn_outcome', ({ outcome }) => {
			if (outcome.turnId !== turnId) return
			sub.unsubscribe()
			resolve(outcome)
		})
	})
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

function createEagerOnlyDeps(opts?: { validateResult?: boolean; specAudioComplete?: Promise<void> }) {
	const transport = createFakeAudioTransport()
	const streamTokenizedCalls: string[] = []
	const preSendTexts: string[] = []
	const speculationEvents: unknown[] = []

	const deps: CallMachineRuntimeDeps = {
		callSignal: new AbortController().signal,
		tts: {
			interrupt: mock.fn(),
			connect: mock.fn(async () => {}),
			close: mock.fn(),
			preSendTextForSynthesis: mock.fn(async (_text: string, onChunk: (chunk: Buffer) => void) => ({
				pushTextDelta: () => {},
				triggerSynthesisStart: () => onChunk(Buffer.alloc(ttsFrameBytes, 1)),
				audioComplete: Promise.resolve(),
			})),
		} as CallMachineRuntimeDeps['tts'],
		specTts: {
			interrupt: mock.fn(),
			connect: mock.fn(async () => {}),
			close: mock.fn(),
			preSendTextForSynthesis: mock.fn(async (text: string, onChunk: (chunk: Buffer) => void) => {
				preSendTexts.push(text)
				return {
					pushTextDelta: () => {},
					triggerSynthesisStart: () => onChunk(Buffer.alloc(ttsFrameBytes, 1)),
					audioComplete: opts?.specAudioComplete ?? Promise.resolve(),
				}
			}),
		} as CallMachineRuntimeDeps['specTts'],
		getAudioTransport: () => transport,
		configureTranscriber: mock.fn(),
		director: {
			generateDraft: mock.fn(async (transcript: string, _controlBlock: string, signal?: AbortSignal) => {
				if (signal?.aborted) return null
				return { userTranscript: transcript, agentResponse: `response for ${transcript}` }
			}),
			streamDraftTokenized: mock.fn((transcript: string) => {
				streamTokenizedCalls.push(transcript)
				return {
					userTranscript: transcript,
					events: (async function* () {
						yield { type: 'token' as const, value: 'fresh response' }
						return 'fresh response'
					})(),
				}
			}),
			commitTurn: mock.fn(),
			listTurns: () => [],
		} as unknown as CallMachineRuntimeDeps['director'],
		backgroundClient: {
			chat: {
				completions: {
					create: mock.fn(async () => ({
						choices: [{ message: { content: '{"needsTool":false,"toolName":null}' } }],
					})),
				},
			},
		} as unknown as CallMachineRuntimeDeps['backgroundClient'],
		metrics: {
			recordBarge: mock.fn(),
			recordSpeculation: mock.fn((event) => speculationEvents.push(event)),
			recordSoftPause: mock.fn(),
			recordTurnOutcome: mock.fn(),
			recordTurnTiming: mock.fn(),
			incrementDiscarded: mock.fn(),
		} as unknown as CallMachineRuntimeDeps['metrics'],
		backgroundIntelligence: {
			runPostCommitTasks: mock.fn(async () => {}),
			addKeyterms: mock.fn(),
			drain: mock.fn(async () => {}),
		} as unknown as CallMachineRuntimeDeps['backgroundIntelligence'],
		incrementTurn: mock.fn(),
		sanitize: (text: string) => text,
		classifyPromotion: mock.fn(async () => opts?.validateResult ?? true),
		buildControlBlock: mock.fn((transcript: string) => `[context] caller: ${transcript}`),
		webSearcher: { search: mock.fn(async () => null) } as CallMachineRuntimeDeps['webSearcher'],
		getCallerDateTime: () => undefined,
		getDirectorTurns: () => [],
		onSilenceHangup: mock.fn(),
	}

	return { deps, streamTokenizedCalls, preSendTexts, speculationEvents }
}

describe('eager-only speculation flow', () => {
	it('does not start speculative generation from agent response text', async () => {
		const h = createEagerOnlyDeps()
		const engine = createCallMachineRuntime(h.deps)

		engine.sendToCallMachine({ type: 'agent_response_ready', turnId: 0, agentResponse: 'Does this help?' })

		await new Promise((resolve) => setTimeout(resolve, 25))
		assert.equal(getEagerState(engine)?.value, 'idle')
		assert.deepEqual(h.streamTokenizedCalls, [])

		engine.stop()
	})

	it('generates one speculative draft at eager end of turn and reuses it after validation', async () => {
		const h = createEagerOnlyDeps({ validateResult: true })
		const engine = createCallMachineRuntime(h.deps)

		engine.sendToCallMachine({
			type: 'caller_eager_turn',
			transcript: 'yeah that sounds good',
			confidence: 0.9,
		})

		await waitForCondition(() => getEagerState(engine)?.value === 'ready', 500)
		assert.deepEqual(h.streamTokenizedCalls, ['yeah that sounds good'])
		assert.equal(getEagerState(engine)?.eagerDraft?.userTranscript, 'yeah that sounds good')
		assert.deepEqual(h.preSendTexts, ['fresh response'])

		const turnId = engine.actor.getSnapshot().context.nextTurnId
		const outcomePromise = waitForOutcome(engine, turnId)
		engine.sendToCallMachine({
			type: 'caller_turn_complete',
			transcript: 'yeah that sounds good',
			confidence: 0.95,
		})
		const outcome = await outcomePromise

		assert.equal(outcome.kind, 'committed')
		assert.ok(
			h.speculationEvents.every((event) => (event as { outcome?: string }).outcome !== 'discarded_diverged'),
			'matching transcript should avoid divergent promotion fallback',
		)

		engine.stop()
	})

	it('falls back fresh when final validation fails', async () => {
		const h = createEagerOnlyDeps({ validateResult: false })
		const engine = createCallMachineRuntime(h.deps)

		engine.sendToCallMachine({
			type: 'caller_eager_turn',
			transcript: 'we have 12 trucks',
			confidence: 0.9,
		})

		await waitForCondition(() => getEagerState(engine)?.value === 'ready', 500)
		const turnId = engine.actor.getSnapshot().context.nextTurnId
		const outcomePromise = waitForOutcome(engine, turnId)
		engine.sendToCallMachine({
			type: 'caller_turn_complete',
			transcript: 'actually we have 120 trucks and need pricing',
			confidence: 0.95,
		})
		const outcome = await outcomePromise

		assert.equal(outcome.kind, 'committed')
		assert.ok(
			h.streamTokenizedCalls.includes('actually we have 120 trucks and need pricing'),
			'failed final validation should use fresh slow path',
		)
		assert.ok(h.speculationEvents.some((event) => (event as { outcome?: string }).outcome === 'discarded_diverged'))

		engine.stop()
	})

	it('does not start next work until presynthesized audio has drained from specTts', async () => {
		const audioGate = deferred<void>()
		const h = createEagerOnlyDeps({ validateResult: true, specAudioComplete: audioGate.promise })
		const engine = createCallMachineRuntime(h.deps)

		engine.sendToCallMachine({ type: 'caller_eager_turn', transcript: 'yeah that sounds good', confidence: 0.9 })
		await waitForCondition(() => getEagerState(engine)?.value === 'ready', 500)

		const turnId = engine.actor.getSnapshot().context.nextTurnId
		const outcomePromise = waitForOutcome(engine, turnId)
		engine.sendToCallMachine({
			type: 'caller_turn_complete',
			transcript: 'yeah that sounds good',
			confidence: 0.95,
		})

		await new Promise((resolve) => setTimeout(resolve, 25))
		assert.equal(
			(h.deps.specTts.interrupt as unknown as ReturnType<typeof mock.fn>).mock.calls.length,
			0,
			'nothing should interrupt active presynthesized TTS',
		)

		audioGate.resolve()
		const outcome = await outcomePromise
		assert.equal(outcome.kind, 'committed')

		engine.stop()
	})

	it('caller_update still does not start speculative generation', async () => {
		const h = createEagerOnlyDeps()
		const engine = createCallMachineRuntime(h.deps)

		engine.sendToCallMachine({ type: 'caller_update', transcript: 'tell me about', confidence: 0.4 })

		await new Promise((resolve) => setTimeout(resolve, 25))
		assert.equal(getEagerState(engine)?.value, 'idle')
		assert.deepEqual(h.streamTokenizedCalls, [])

		engine.stop()
	})
})
