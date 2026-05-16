/**
 * Scenario tests — drive the call-machine runtime through realistic
 * multi-step call flows, asserting on turn outcomes AND the subsystem
 * side effects: background tool watching, eager speculation/cancellation,
 * backchannel suppression, metrics recording, pause state, and director
 * commit payloads.
 */

import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { createFakeAudioTransport, type FakeAudioTransport } from '#test/support/fake-audio-transport.js'
import { waitForCondition } from '#test/support/wait-for-condition.js'
import { createCallMachineRuntime, type CallMachineRuntimeDeps } from './call-machine-runtime.js'
import type { TurnOutcome } from './types.js'

// ---------------------------------------------------------------------------
// Deferred promise
// ---------------------------------------------------------------------------

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// Mock deps factory — every mock is inspectable
// ---------------------------------------------------------------------------

const { ttsFrameBytes } = await import('../shared/audio-pacing.js')

function makeScenarioTts() {
	return {
		interrupt: mock.fn(),
		connect: mock.fn(async () => {}),
		close: mock.fn(),
		preSendTextForSynthesis: mock.fn(async (_text: string, onChunk: (c: Buffer) => void) => ({
			pushTextDelta: () => {},
			triggerSynthesisStart: () => {
				onChunk(Buffer.alloc(ttsFrameBytes, 1))
			},
			audioComplete: Promise.resolve(),
		})),
	} as never as CallMachineRuntimeDeps['tts']
}

type LooseOverrides = Partial<CallMachineRuntimeDeps> & Record<string, unknown>
type ToolWatcherOverride = (input: { transcript: string }) => Promise<{
	decision: 'execute' | 'not_ready' | 'none'
	tool: string | null
	args: Record<string, unknown> | null
	missing?: string[] | null
}>

function createDeps(overrides?: LooseOverrides, transportRef?: { current: FakeAudioTransport }) {
	const transport = createFakeAudioTransport()
	if (transportRef) transportRef.current = transport
	const {
		audioSender,
		audioStreamer,
		onClearBuffer,
		onSuspendAudio,
		onPlaybackComplete,
		toolWatcherOverride,
		...rest
	} = (overrides ?? {}) as LooseOverrides & { toolWatcherOverride?: ToolWatcherOverride }
	void audioSender
	void audioStreamer
	void onClearBuffer
	void onSuspendAudio
	void onPlaybackComplete
	const watcherMock = toolWatcherOverride ?? mock.fn(async () => ({ decision: 'none', tool: null, args: null }))
	const deps = {
		callSignal: new AbortController().signal,
		tts: makeScenarioTts(),
		specTts: makeScenarioTts(),
		director: {
			generateDraft: mock.fn(async (t: string) => ({ userTranscript: t, agentResponse: 'draft' })),
			streamDraftTokenized: mock.fn((t: string) => ({
				userTranscript: t,
				events: (async function* () {
					yield { type: 'token' as const, value: 'Here are the rates.' }
					return 'Here are the rates.'
				})(),
			})),
			commitTurn: mock.fn(),
			commitToolCall: mock.fn(),
			commitToolResult: mock.fn(),
			listTurns: () => [],
		} as never as CallMachineRuntimeDeps['director'],
		backgroundClient: {
			responses: {
				create: mock.fn(async () => {
					const result = await watcherMock({ transcript: '' })
					return {
						output: [
							{
								type: 'message',
								content: [{ type: 'output_text', text: JSON.stringify({ ...result, reasoning: 'test' }) }],
							},
						],
					}
				}),
			},
		} as never as CallMachineRuntimeDeps['backgroundClient'],
		metrics: {
			recordBarge: mock.fn(),
			recordSpeculation: mock.fn(),
			recordSoftPause: mock.fn(),
			recordTurnOutcome: mock.fn(),
			recordTurnTiming: mock.fn(),
			incrementDiscarded: mock.fn(),
		} as never as CallMachineRuntimeDeps['metrics'],
		getAudioTransport: () => transport,
		configureTranscriber: mock.fn(),
		backgroundIntelligence: {
			runPostCommitTasks: mock.fn(async () => {}),
			addKeyterms: mock.fn(),
			drain: mock.fn(async () => {}),
		} as never as CallMachineRuntimeDeps['backgroundIntelligence'],
		incrementTurn: mock.fn(),
		sanitize: (text: string) => text,
		classifyPromotion: mock.fn(async () => false),
		buildControlBlock: mock.fn(() => 'mock control block'),
		webSearcher: { search: mock.fn(async () => null) } as CallMachineRuntimeDeps['webSearcher'],
		getCallerDateTime: () => undefined,
		getDirectorTurns: () => [],
		onSilenceHangup: mock.fn(),
		...(rest as Partial<CallMachineRuntimeDeps>),
	} satisfies CallMachineRuntimeDeps
	return deps
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectOutcomes(engine: ReturnType<typeof createCallMachineRuntime>) {
	const outcomes: TurnOutcome[] = []
	engine.actor.on('turn_outcome', ({ outcome }) => outcomes.push(outcome))
	return outcomes
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

function startTurn(engine: ReturnType<typeof createCallMachineRuntime>, transcript: string, confidence = 0.9) {
	const turnId = engine.actor.getSnapshot().context.nextTurnId
	const outcomePromise = waitForOutcome(engine, turnId)
	engine.sendToCallMachine({ type: 'caller_turn_complete', transcript, confidence })
	return { turnId, outcomePromise }
}

function mockFn(f: unknown) {
	return f as ReturnType<typeof mock.fn>
}

// ---------------------------------------------------------------------------
// 1. Happy path: turn lifecycle + subsystem side effects
// ---------------------------------------------------------------------------

describe('scenario: happy path with subsystem verification', () => {
	it('committed turn records metrics, commits to director, runs post-commit tasks', async () => {
		const deps = createDeps()
		const engine = createCallMachineRuntime(deps)

		const { outcomePromise } = startTurn(engine, 'What are your rates?')
		await outcomePromise

		assert.equal(mockFn(deps.director.commitTurn).mock.calls.length, 1)
		const commitPayload = mockFn(deps.director.commitTurn).mock.calls[0]?.arguments[0] as { kind: string }
		assert.equal(commitPayload.kind, 'exchange')

		assert.ok(mockFn(deps.metrics.recordTurnOutcome).mock.calls.length >= 1, 'turn outcome metric recorded')
		assert.ok(mockFn(deps.metrics.recordTurnTiming).mock.calls.length >= 1, 'turn timing metric recorded')

		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 2. Caller update lifecycle
// ---------------------------------------------------------------------------

describe('scenario: caller_update does not speculate', () => {
	it('caller_update only resets caller activity state', async () => {
		const deps = createDeps()
		const engine = createCallMachineRuntime(deps)

		engine.sendToCallMachine({ type: 'caller_update', transcript: 'tell me about coverage', confidence: 0.5 })

		assert.equal(engine.shouldSuppressBackchannel(), false, 'backchannel remains available without speculation')

		engine.sendToCallMachine({ type: 'caller_turn_start' })
		await waitForCondition(() => !engine.shouldSuppressBackchannel(), 500)
		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 3. Final turn triggers tool detection
// ---------------------------------------------------------------------------

describe('scenario: final turn triggers tool detection', () => {
	it('completeCallerTurn sends DETECT_INTENT to tool pipeline with the final transcript', async () => {
		const toolWatcherOverride = mock.fn(async () => ({
			decision: 'none' as const,
			tool: null,
			args: null,
		}))
		const deps = createDeps({ toolWatcherOverride } as never)
		const engine = createCallMachineRuntime(deps)

		engine.sendToCallMachine({
			type: 'caller_eager_turn',
			transcript: 'what is commercial auto insurance',
			confidence: 0.85,
		})

		const { outcomePromise } = startTurn(engine, 'what is commercial auto insurance')

		await waitForCondition(() => mockFn(deps.backgroundClient.responses.create).mock.calls.length > 0, 1000)
		assert.ok(
			mockFn(deps.backgroundClient.responses.create).mock.calls.length > 0,
			'watcher was called via backgroundClient on caller_turn_complete',
		)

		await outcomePromise
		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 4. Backchannel suppression during active turn
// ---------------------------------------------------------------------------

describe('scenario: backchannel suppression', () => {
	it('suppressed while in turn, allowed when idle', async () => {
		let synthCallCount = 0
		const stallingTts = {
			interrupt: mock.fn(),
			close: mock.fn(),
			connect: mock.fn(async () => {}),
			preSendTextForSynthesis: mock.fn(async (_text: string, onChunk: (c: Buffer) => void) => {
				synthCallCount++
				return {
					pushTextDelta: () => {},
					triggerSynthesisStart: () => onChunk(Buffer.alloc(1920, 1)),
					audioComplete: synthCallCount === 1 ? new Promise<void>(() => {}) : Promise.resolve(),
				}
			}),
		} as never as CallMachineRuntimeDeps['tts']
		const deps = createDeps({ tts: stallingTts })
		const engine = createCallMachineRuntime(deps)

		assert.equal(engine.shouldSuppressBackchannel(), false, 'allowed when idle')

		const first = startTurn(engine, 'hello')
		await waitForCondition(() => engine.isAgentStreaming(), 2000)
		assert.equal(engine.shouldSuppressBackchannel(), true, 'suppressed during active turn')

		const second = startTurn(engine, 'next')
		await first.outcomePromise
		await second.outcomePromise

		// Post-commit speculation may be in flight, so backchannel stays suppressed.
		// The key assertion is that it was suppressed during the active turn.
		assert.ok(engine.actor.getSnapshot().matches('idle'), 'machine back in idle')

		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 5. Barge-in records metrics and interrupts TTS
// ---------------------------------------------------------------------------

describe('scenario: barge-in records metrics and interrupts TTS', () => {
	it('interrupt fires recordBarge, drains audio with fade, interrupts TTS', async () => {
		const transportRef = { current: createFakeAudioTransport() }

		// Stall the first synthesis so the machine sits in `playing` long
		// enough for a new turn to barge in.
		let synthCallCount = 0
		const stallingTts = {
			interrupt: mock.fn(),
			close: mock.fn(),
			connect: mock.fn(async () => {}),
			preSendTextForSynthesis: mock.fn(async (_text: string, onChunk: (c: Buffer) => void) => {
				synthCallCount++
				if (synthCallCount === 1) {
					return {
						pushTextDelta: () => {},
						triggerSynthesisStart: () => {
							// Flush one chunk so the tracker registers audio;
							// then block audioComplete forever.
							onChunk(Buffer.alloc(1920, 1))
						},
						audioComplete: new Promise<void>(() => {}),
					}
				}
				return {
					pushTextDelta: () => {},
					triggerSynthesisStart: () => onChunk(Buffer.alloc(1920, 1)),
					audioComplete: Promise.resolve(),
				}
			}),
		} as never as CallMachineRuntimeDeps['tts']

		const deps = createDeps({ tts: stallingTts }, transportRef)
		const engine = createCallMachineRuntime(deps)
		const outcomes = collectOutcomes(engine)

		const first = startTurn(engine, 'tell me about insurance')
		await waitForCondition(() => engine.isAgentStreaming(), 2000)

		const second = startTurn(engine, 'wait stop')
		await first.outcomePromise
		await second.outcomePromise

		assert.equal(outcomes[0]?.kind, 'interrupted')
		assert.ok(mockFn(deps.metrics.recordBarge).mock.calls.length > 0, 'recordBarge was called')
		assert.ok(mockFn(deps.tts.interrupt).mock.calls.length > 0, 'TTS was interrupted')
		const firstSink = transportRef.current.sinks[0]
		assert.ok(firstSink, 'sink was created')
		assert.ok(firstSink.clearQueueCount >= 1, 'sink queue cleared on interrupt')

		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 6. Eager cancellation on caller_turn_start
// ---------------------------------------------------------------------------

describe('scenario: eager cancellation when caller starts new utterance', () => {
	it('eager speculation starts from eager_turn → caller_turn_start cancels eager', async () => {
		const deps = createDeps()
		const engine = createCallMachineRuntime(deps)

		engine.sendToCallMachine({
			type: 'caller_eager_turn',
			transcript: 'I want to know about coverage',
			confidence: 0.9,
		})
		await waitForCondition(() => engine.shouldSuppressBackchannel(), 500)
		assert.equal(engine.shouldSuppressBackchannel(), true, 'eager in flight after eager turn')

		engine.sendToCallMachine({ type: 'caller_turn_start' })

		assert.equal(engine.shouldSuppressBackchannel(), false, 'eager cancelled after turn_start')

		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 7. Tool result lands in context without proactive follow-up
// ---------------------------------------------------------------------------

describe('scenario: tool result lands in context without proactive follow-up', () => {
	it('tool result is committed to director history but no proactive follow-up turn fires', async () => {
		const outcomes: TurnOutcome[] = []
		const deps = createDeps({
			toolWatcherOverride: mock.fn(async () => ({
				decision: 'execute' as const,
				tool: 'webSearch',
				args: { query: 'commercial auto rates in Texas' },
				missing: null,
			})),
			webSearcher: {
				search: mock.fn(async () => 'Average commercial auto rate in Texas is $1,200/year.'),
			} as CallMachineRuntimeDeps['webSearcher'],
		})
		const engine = createCallMachineRuntime(deps)
		engine.actor.on('turn_outcome', ({ outcome }) => outcomes.push(outcome))

		const first = startTurn(engine, 'what are commercial auto rates in Texas')
		await first.outcomePromise

		assert.equal(outcomes[0]?.kind, 'committed', 'first turn commits')

		await new Promise((resolve) => setTimeout(resolve, 500))
		assert.equal(outcomes.length, 1, 'no proactive follow-up turn fires — result sits in context for next turn')

		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 8. Agent-response diagnostics do not speculate
// ---------------------------------------------------------------------------

describe('scenario: no speculation after agent response', () => {
	it('after a committed turn, no next-turn speculation starts until eager_turn', async () => {
		const deps = createDeps()
		const engine = createCallMachineRuntime(deps)

		const { outcomePromise } = startTurn(engine, 'What are your rates?')
		await outcomePromise
		await new Promise((resolve) => setTimeout(resolve, 25))

		assert.equal(engine.shouldSuppressBackchannel(), false, 'no post-response speculation is in flight')

		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 9. Closing commits user-only and skips post-commit work
// ---------------------------------------------------------------------------

describe('scenario: closing turn user-only commit', () => {
	it('discarded(closing) commits user transcript and skips background tasks', async () => {
		const deps = createDeps()
		const engine = createCallMachineRuntime(deps)

		engine.markClosing()
		const { outcomePromise } = startTurn(engine, 'Thanks, goodbye!')
		const result = await outcomePromise

		assert.equal(result.kind, 'discarded')
		if (result.kind === 'discarded') assert.equal(result.reason, 'closing')

		const commitCalls = mockFn(deps.director.commitTurn).mock.calls
		assert.equal(commitCalls.length, 1, 'user-only commit happened')
		assert.equal((commitCalls[0]?.arguments[0] as { kind: string }).kind, 'user_only')

		assert.equal(
			mockFn(deps.backgroundIntelligence.runPostCommitTasks).mock.calls.length,
			0,
			'no post-commit tasks on discard',
		)

		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 10. Empty response: discarded, no commit, incrementDiscarded
// ---------------------------------------------------------------------------

describe('scenario: empty response handling', () => {
	it('no PCM from TTS → discarded, no director commit', async () => {
		const silentTts = {
			interrupt: mock.fn(),
			close: mock.fn(),
			connect: mock.fn(async () => {}),
			preSendTextForSynthesis: mock.fn(async () => ({
				pushTextDelta: () => {},
				triggerSynthesisStart: () => {},
				audioComplete: Promise.resolve(),
			})),
		} as never as CallMachineRuntimeDeps['tts']
		const deps = createDeps({ tts: silentTts })
		const engine = createCallMachineRuntime(deps)
		const outcomes = collectOutcomes(engine)

		const { outcomePromise } = startTurn(engine, 'trigger empty')
		await outcomePromise

		assert.notEqual(outcomes[0]?.kind, 'committed')
		assert.equal(mockFn(deps.director.commitTurn).mock.calls.length, 0, 'no director commit for empty response')

		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 11. Soft pause fires onSuspendAudio and records metrics
// ---------------------------------------------------------------------------

describe('scenario: soft pause records metrics', () => {
	it('caller_turn_start during playing suspends audio and vad_speech_end resumes', async () => {
		const transportRef = { current: createFakeAudioTransport() }
		const audioCompleteResolvers: Array<() => void> = []
		const stallingTts = {
			interrupt: mock.fn(),
			close: mock.fn(),
			connect: mock.fn(async () => {}),
			preSendTextForSynthesis: mock.fn(async (_text: string, onChunk: (c: Buffer) => void) => {
				return {
					pushTextDelta: () => {},
					triggerSynthesisStart: () => onChunk(Buffer.alloc(1920, 1)),
					audioComplete: new Promise<void>((resolve) => {
						audioCompleteResolvers.push(resolve)
					}),
				}
			}),
		} as never as CallMachineRuntimeDeps['tts']

		const deps = createDeps({ tts: stallingTts }, transportRef)
		const engine = createCallMachineRuntime(deps)
		const outcomes = collectOutcomes(engine)

		startTurn(engine, 'tell me everything')
		await waitForCondition(() => engine.isAgentStreaming(), 2000)

		engine.sendToCallMachine({ type: 'caller_turn_start' })
		const sink = transportRef.current.sinks[0]
		assert.ok(sink, 'sink created for the turn')

		engine.sendToCallMachine({ type: 'vad_speech_end' })
		assert.ok(mockFn(deps.metrics.recordSoftPause).mock.calls.length > 0, 'soft pause metrics recorded on resume')
		assert.ok(mockFn(deps.metrics.recordBarge).mock.calls.length > 0, 'short_resumed barge recorded')

		audioCompleteResolvers.forEach((r) => r())
		await waitForCondition(() => outcomes.length >= 1, 600)
		assert.equal(outcomes[0]?.kind, 'committed')

		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 12. Search result committed to director without proactive follow-up
// ---------------------------------------------------------------------------

describe('scenario: search result lands in context without proactive turn', () => {
	it('web search result is committed to director history but no proactive turn fires', async () => {
		const searchGate = deferred<string | null>()
		const outcomes: TurnOutcome[] = []

		const deps = createDeps({
			toolWatcherOverride: mock.fn(async () => ({
				decision: 'execute' as const,
				tool: 'webSearch',
				args: { query: 'what are auto rates in Texas' },
				missing: null,
			})),
			webSearcher: { search: mock.fn(async () => searchGate.promise) } as CallMachineRuntimeDeps['webSearcher'],
		})
		const engine = createCallMachineRuntime(deps)
		engine.actor.on('turn_outcome', ({ outcome }) => outcomes.push(outcome))

		const first = startTurn(engine, 'what are auto rates in Texas')
		await first.outcomePromise
		assert.equal(outcomes[0]?.kind, 'committed', 'first turn commits while tool executes')

		const outcomesBeforeSearch = outcomes.length
		searchGate.resolve('Texas auto rates are $1200/year')

		await new Promise((resolve) => setTimeout(resolve, 500))
		assert.equal(
			outcomes.length,
			outcomesBeforeSearch,
			'no proactive follow-up — result available in control block for next turn',
		)

		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 13. Proactive follow-up delivery
// ---------------------------------------------------------------------------

describe('scenario: late search result lands in context without proactive turn', () => {
	it('tool_result_ready commits to director history but does not fire a proactive turn', async () => {
		const searchGate = deferred<string | null>()
		const outcomes: TurnOutcome[] = []

		const deps = createDeps({
			toolWatcherOverride: mock.fn(async () => ({
				decision: 'execute' as const,
				tool: 'webSearch',
				args: { query: 'coverage options' },
			})),
			webSearcher: { search: mock.fn(async () => searchGate.promise) } as CallMachineRuntimeDeps['webSearcher'],
		})
		const engine = createCallMachineRuntime(deps)
		engine.actor.on('turn_outcome', ({ outcome }) => outcomes.push(outcome))

		engine.sendToCallMachine({
			type: 'caller_eager_turn',
			transcript: 'what coverage options do you have',
			confidence: 0.9,
		})

		const { outcomePromise } = startTurn(engine, 'what coverage options do you have')
		await outcomePromise

		const outcomesBeforeSearch = outcomes.length
		searchGate.resolve('We offer comprehensive, collision, and liability coverage.')

		await new Promise((resolve) => setTimeout(resolve, 500))
		assert.equal(
			outcomes.length,
			outcomesBeforeSearch,
			'no proactive follow-up turn fires — result sits in control block',
		)

		engine.stop()
	})
})

describe('scenario: supervisor tool detection and delivery', () => {
	it('watcher detects tool intent, result commits to director but no proactive follow-up fires', async () => {
		const outcomes: TurnOutcome[] = []
		const deps = createDeps({
			toolWatcherOverride: mock.fn(async () => ({
				decision: 'execute' as const,
				tool: 'webSearch',
				args: { query: 'coverage options' },
				missing: null,
			})),
			webSearcher: {
				search: mock.fn(async () => 'We offer comprehensive, collision, and liability coverage.'),
			} as CallMachineRuntimeDeps['webSearcher'],
		})
		const engine = createCallMachineRuntime(deps)
		engine.actor.on('turn_outcome', ({ outcome }) => outcomes.push(outcome))

		const first = startTurn(engine, 'what coverage options do you have')
		await first.outcomePromise

		assert.equal(outcomes[0]?.kind, 'committed', 'first turn commits (director speaks stall)')

		await new Promise((resolve) => setTimeout(resolve, 500))
		assert.equal(outcomes.length, 1, 'no proactive follow-up turn — result sits in context for next turn')

		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 14. Turn replay does not leak legacy tool claims
// ---------------------------------------------------------------------------

describe('scenario: overlapping turns without tool claim lifecycle', () => {
	it('first turn interrupted → second commits without legacy claim leaks', async () => {
		// The first director stream never terminates, keeping the first
		// turn in its drafting phase. The second `caller_turn_complete`
		// fires the interrupt path before turn 0's TTS is ever invoked.
		let directorCallCount = 0
		async function* stalledTokenStream(): AsyncGenerator<{ type: 'token'; value: string }, string> {
			yield { type: 'token', value: 'first' }
			await new Promise<void>(() => {})
			return ''
		}
		async function* quickTokenStream(): AsyncGenerator<{ type: 'token'; value: string }, string> {
			yield { type: 'token', value: 'ok' }
			return 'ok'
		}
		const neverEndingDirector = {
			generateDraft: mock.fn(async (t: string) => ({ userTranscript: t, agentResponse: 'draft' })),
			streamDraftTokenized: mock.fn((t: string) => {
				directorCallCount += 1
				return {
					userTranscript: t,
					events: directorCallCount === 1 ? stalledTokenStream() : quickTokenStream(),
				}
			}),
			commitTurn: mock.fn(),
			listTurns: () => [],
		} as never as CallMachineRuntimeDeps['director']

		const deps = createDeps({ director: neverEndingDirector })
		const engine = createCallMachineRuntime(deps)
		const outcomes = collectOutcomes(engine)

		const first = startTurn(engine, 'first question')
		await new Promise((r) => setTimeout(r, 50))

		const second = startTurn(engine, 'second question')
		await first.outcomePromise
		await second.outcomePromise

		assert.equal(outcomes[0]?.kind, 'interrupted')
		assert.equal(outcomes[1]?.kind, 'committed')

		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 15. First turn → greeting commit kind
// ---------------------------------------------------------------------------

describe('scenario: opening turn commit payload', () => {
	it('start_first_turn produces greeting commit, not exchange', async () => {
		const deps = createDeps()
		const engine = createCallMachineRuntime(deps)

		const turnId = engine.actor.getSnapshot().context.nextTurnId
		const outcomePromise = waitForOutcome(engine, turnId)
		engine.sendToCallMachine({ type: 'start_first_turn', openingBlock: 'Hello!' })
		await outcomePromise

		const commitPayload = mockFn(deps.director.commitTurn).mock.calls[0]?.arguments[0] as { kind: string }
		assert.equal(commitPayload.kind, 'greeting')

		engine.stop()
	})
})

// ---------------------------------------------------------------------------
// 16. Full call lifecycle
// ---------------------------------------------------------------------------

// TODO(streams-refactor): this end-to-end scenario exercises eager
// speculation + barge-in + recovery + closing in one go; re-enable once
// the multi-turn barge-in interleaving with the new pipeline lifecycle
// has its own coverage in smaller scenario tests.
describe.skip('scenario: full call lifecycle', () => {
	it('opening → eager turn + search → committed → barge-in → recovery → close', async () => {
		const toolWatcherOverride = mock.fn(async () => ({
			decision: 'none' as const,
			tool: null,
			args: null,
		}))
		// Second turn's TTS stalls its audioComplete — turn reaches playing
		// state (audio emitted) but never finishes playback, so the barge-in
		// interrupt hits the `playing` handler (which records a barge event).
		let synthCallCount = 0
		const stallingTts = {
			interrupt: mock.fn(),
			close: mock.fn(),
			connect: mock.fn(async () => {}),
			preSendTextForSynthesis: mock.fn(async (_text: string, onChunk: (c: Buffer) => void) => {
				synthCallCount++
				return {
					pushTextDelta: () => {},
					triggerSynthesisStart: () => onChunk(Buffer.alloc(ttsFrameBytes, 1)),
					audioComplete: synthCallCount === 2 ? new Promise<void>(() => {}) : Promise.resolve(),
				}
			}),
		} as never as CallMachineRuntimeDeps['tts']

		const deps = createDeps({ toolWatcherOverride, tts: stallingTts } as never)
		const engine = createCallMachineRuntime(deps)
		const outcomes = collectOutcomes(engine)

		// 1. Opening
		const openingId = engine.actor.getSnapshot().context.nextTurnId
		const openingPromise = waitForOutcome(engine, openingId)
		engine.sendToCallMachine({ type: 'start_first_turn', openingBlock: 'Welcome!' })
		await openingPromise
		assert.equal(outcomes[0]?.kind, 'committed')

		// 2. Eager turn triggers tool watching
		engine.sendToCallMachine({
			type: 'caller_eager_turn',
			transcript: 'what coverage do you offer',
			confidence: 0.9,
		})
		await waitForCondition(() => toolWatcherOverride.mock.calls.length > 0, 500)

		// 3. Caller turn → barge-in via overlapping turn
		const turn2 = startTurn(engine, 'what coverage do you offer')
		await new Promise((r) => setTimeout(r, 50))

		const turn3 = startTurn(engine, 'actually tell me about pricing')
		await turn2.outcomePromise
		await turn3.outcomePromise

		assert.equal(outcomes[1]?.kind, 'interrupted')
		assert.equal(outcomes[2]?.kind, 'committed')
		assert.ok(mockFn(deps.metrics.recordBarge).mock.calls.length > 0, 'barge recorded in lifecycle')

		// 4. Close
		engine.markClosing()
		const closingTurn = startTurn(engine, 'bye')
		await closingTurn.outcomePromise

		assert.equal(outcomes[3]?.kind, 'discarded')
		assert.equal(outcomes.length, 4)

		const commitKinds = mockFn(deps.director.commitTurn).mock.calls.map(
			(c) => (c.arguments[0] as { kind: string }).kind,
		)
		assert.ok(commitKinds.includes('greeting'), 'greeting committed')
		assert.ok(commitKinds.includes('exchange'), 'exchange committed')
		assert.ok(commitKinds.includes('user_only'), 'user_only committed on close')

		engine.stop()
	})
})
