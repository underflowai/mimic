import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { createMockRuntimeDeps } from '#test/support/mock-runtime-deps.js'
import type { TtsSynthesisListener } from '../audio/tts-speaker.js'
import { createCallEventRecorder } from '../replay/event-log.js'
import { ttsFrameBytes } from '../shared/audio-format.js'
import { createCallMachineRuntime, type CallMachineRuntimeDeps } from './call-machine-runtime.js'
import type { TurnOutcome } from './types.js'

function waitForTurnOutcome(engine: ReturnType<typeof createCallMachineRuntime>, turnId: number) {
	return new Promise<TurnOutcome>((resolve) => {
		const sub = engine.actor.on('turn_outcome', ({ outcome }) => {
			if (outcome.turnId !== turnId) return
			sub.unsubscribe()
			resolve(outcome)
		})
	})
}

function startCallerTurnComplete(
	engine: ReturnType<typeof createCallMachineRuntime>,
	transcript: string,
	confidence: number,
) {
	const turnId = engine.actor.getSnapshot().context.nextTurnId
	const outcomePromise = waitForTurnOutcome(engine, turnId)
	engine.sendToCallMachine({ type: 'caller_turn_complete', transcript, confidence })
	return { turnId, outcomePromise }
}

describe('call-machine runtime phase selectors', () => {
	const selectorCases = [
		{
			name: 'idle defaults',
			drive: async (_engine: ReturnType<typeof createCallMachineRuntime>) => {},
			expected: { streaming: false, suppressBackchannel: false },
		},
		{
			name: 'caller update does not speculate',
			drive: async (engine: ReturnType<typeof createCallMachineRuntime>) => {
				engine.sendToCallMachine({ type: 'caller_update', transcript: 'one two three', confidence: 0.5 })
			},
			expected: { streaming: false, suppressBackchannel: false },
		},
		{
			name: 'eager phase',
			drive: async (engine: ReturnType<typeof createCallMachineRuntime>) => {
				engine.sendToCallMachine({ type: 'caller_eager_turn', transcript: 'coverage options', confidence: 0.9 })
			},
			expected: { streaming: false, suppressBackchannel: true },
		},
	] as const

	for (const testCase of selectorCases) {
		it(testCase.name, async () => {
			const { deps } = createMockRuntimeDeps()
			const engine = createCallMachineRuntime(deps)
			await testCase.drive(engine)
			assert.equal(engine.isAgentStreaming(), testCase.expected.streaming)
			assert.equal(engine.shouldSuppressBackchannel(), testCase.expected.suppressBackchannel)
			engine.stop()
		})
	}
})

describe('call-machine runtime caller_turn_complete flow', () => {
	it('passes the reference time and earlier caller details to the tool watcher', { timeout: 3_000 }, async () => {
		const base = createMockRuntimeDeps()
		let captureRequest!: (request: unknown) => void
		const observed = new Promise<unknown>((resolve) => {
			captureRequest = resolve
		})
		const engine = createCallMachineRuntime({
			...base.deps,
			getCallerDateTime: () => 'October 1, 2026, 9:00 AM America/New_York',
			getDirectorTurns: () => [
				{ role: 'user', content: 'Earlier verified reference: ORIGINAL-REFERENCE.' },
				...Array.from({ length: 12 }, () => ({ role: 'agent' as const, content: 'A later exchange.' })),
			],
			backgroundClient: {
				responses: {
					create: async (request: unknown) => {
						captureRequest(request)
						return {
							output: [
								{
									type: 'message',
									content: [
										{
											type: 'output_text',
											text: JSON.stringify({
												decision: 'none',
												tool: null,
												args: null,
												missing: null,
												directorNote: null,
												reasoning: 'No action requested.',
												writeAuthorizationQuote: null,
												cancelExisting: false,
											}),
										},
									],
								},
							],
						}
					},
				},
			} as unknown as CallMachineRuntimeDeps['backgroundClient'],
		})
		try {
			engine.sendToCallMachine({ type: 'caller_turn_complete', transcript: 'Thank you.', confidence: 0.9 })
			const request = JSON.stringify(await observed)
			assert.match(request, /ORIGINAL-REFERENCE/)
			assert.match(request, /October 1, 2026, 9:00 AM America\/New_York/)
		} finally {
			engine.stop()
		}
	})

	it('emits discarded and commits user-only when closing', async () => {
		const commitTurn = mock.fn()
		const base = createMockRuntimeDeps()
		const deps: CallMachineRuntimeDeps = {
			...base.deps,
			director: {
				...base.deps.director,
				commitTurn,
			} as CallMachineRuntimeDeps['director'],
		}
		const engine = createCallMachineRuntime(deps)
		engine.markClosing()

		const { outcomePromise } = startCallerTurnComplete(engine, 'please keep this', 0.8)
		const result = await outcomePromise
		assert.equal(result.kind, 'discarded')
		assert.equal(commitTurn.mock.calls.length, 1)
		assert.deepEqual(commitTurn.mock.calls[0]?.arguments[0], { kind: 'user_only', user: 'please keep this' })

		engine.stop()
	})
})

describe('call-machine runtime: [end-call] tag', () => {
	function depsWithGoodbyeDraft(endCallEnabled: boolean) {
		const onHangupRequested = mock.fn<CallMachineRuntimeDeps['onHangupRequested']>()
		const base = createMockRuntimeDeps()
		const deps: CallMachineRuntimeDeps = {
			...base.deps,
			endCallEnabled,
			onHangupRequested,
			director: {
				...base.deps.director,
				streamDraftTokenized: mock.fn((transcript: string) => ({
					userTranscript: transcript,
					events: (async function* () {
						yield { type: 'token' as const, value: 'Goodbye for now! ' }
						yield { type: 'token' as const, value: '[end-call]' }
						return 'Goodbye for now! [end-call]'
					})(),
				})),
			} as CallMachineRuntimeDeps['director'],
		}
		return { deps, onHangupRequested }
	}

	it('requests a hangup after the goodbye turn commits when enabled', async () => {
		const { deps, onHangupRequested } = depsWithGoodbyeDraft(true)
		const engine = createCallMachineRuntime(deps)

		const { outcomePromise } = startCallerTurnComplete(engine, 'bye then', 0.9)
		const result = await outcomePromise

		assert.equal(result.kind, 'committed')
		if (result.kind === 'committed') {
			assert.equal(result.turn.endCallRequested, true)
			assert.equal(result.turn.agentResponse.includes('[end-call]'), false, 'tag is stripped from the transcript')
		}
		assert.deepEqual(
			onHangupRequested.mock.calls.map((c) => c.arguments[0]),
			['end_call_tag'],
		)

		engine.stop()
	})

	it('strips the tag but ignores it when disabled', async () => {
		const { deps, onHangupRequested } = depsWithGoodbyeDraft(false)
		const engine = createCallMachineRuntime(deps)

		const { outcomePromise } = startCallerTurnComplete(engine, 'bye then', 0.9)
		const result = await outcomePromise

		assert.equal(result.kind, 'committed')
		if (result.kind === 'committed') {
			assert.equal(result.turn.agentResponse.includes('[end-call]'), false)
		}
		assert.equal(onHangupRequested.mock.calls.length, 0)

		engine.stop()
	})
})

describe('call-machine runtime: end-of-turn confidence', () => {
	it('skips eager speculation below the low-confidence floor', async () => {
		const { deps } = createMockRuntimeDeps()
		const engine = createCallMachineRuntime(deps)
		const stream = deps.director.streamDraftTokenized as unknown as ReturnType<typeof mock.fn>

		engine.sendToCallMachine({ type: 'caller_eager_turn', transcript: 'so I was', confidence: 0.31 })
		await new Promise((r) => setTimeout(r, 10))
		assert.equal(stream.mock.callCount(), 0, 'no draft for a barely-there eager boundary')

		engine.sendToCallMachine({ type: 'caller_eager_turn', transcript: 'so I was thinking Tuesday', confidence: 0.6 })
		await new Promise((r) => setTimeout(r, 10))
		assert.equal(stream.mock.callCount(), 1)

		engine.stop()
	})

	it('marks a timeout-forced low-confidence final as trailing off in the control block', async () => {
		const { deps } = createMockRuntimeDeps()
		const engine = createCallMachineRuntime(deps)
		const buildControlBlock = deps.buildControlBlock as unknown as ReturnType<typeof mock.fn>

		const { outcomePromise } = startCallerTurnComplete(engine, 'my email is john dot', 0.21)
		await outcomePromise

		const call = buildControlBlock.mock.calls.find((c) => c.arguments[0] === 'my email is john dot')
		assert.ok(call)
		assert.equal((call.arguments[1] as { trailingOff?: boolean }).trailingOff, true)

		const { outcomePromise: confident } = startCallerTurnComplete(engine, 'john dot smith at gmail dot com', 0.9)
		await confident
		const confidentCall = buildControlBlock.mock.calls.find((c) => c.arguments[0] === 'john dot smith at gmail dot com')
		assert.equal((confidentCall!.arguments[1] as { trailingOff?: boolean }).trailingOff, false)

		engine.stop()
	})
})

describe('call-machine runtime: careful endpointing', () => {
	it('raises the EOT bar after the agent asks for an email and restores it after the reply', async () => {
		const base = createMockRuntimeDeps()
		const deps: CallMachineRuntimeDeps = {
			...base.deps,
			director: {
				...base.deps.director,
				streamDraftTokenized: mock.fn((transcript: string) => ({
					userTranscript: transcript,
					events: (async function* () {
						const text = transcript.startsWith('book')
							? "Sure. What's the best email address for the confirmation?"
							: 'Got it, thanks.'
						yield { type: 'token' as const, value: text }
						return text
					})(),
				})),
			} as CallMachineRuntimeDeps['director'],
		}
		const configure = deps.configureTranscriber as unknown as ReturnType<typeof mock.fn>
		const engine = createCallMachineRuntime(deps)

		const first = startCallerTurnComplete(engine, 'book me in for tuesday', 0.9)
		await first.outcomePromise
		assert.equal(configure.mock.callCount(), 1)
		const careful = configure.mock.calls[0]!.arguments[0] as { eotThreshold: number; eotTimeoutMs: number }
		assert.ok(careful.eotThreshold > 0.7)
		assert.ok(careful.eotTimeoutMs > 3000)

		const second = startCallerTurnComplete(engine, 'john dot smith at gmail dot com', 0.9)
		await second.outcomePromise
		assert.equal(configure.mock.callCount(), 2, 'defaults restored once the caller turn arrives')
		const restored = configure.mock.calls[1]!.arguments[0] as { eotThreshold: number; eotTimeoutMs: number }
		assert.ok(restored.eotThreshold < careful.eotThreshold)

		const third = startCallerTurnComplete(engine, 'thanks', 0.9)
		await third.outcomePromise
		assert.equal(configure.mock.callCount(), 2, 'ordinary agent lines leave endpointing alone')

		engine.stop()
	})
})

describe('call-machine runtime: latency filler', () => {
	it('speaks a filler when the first token is late and keeps the model text', async () => {
		const base = createMockRuntimeDeps()
		const recordLatencyFiller = mock.fn()
		const deps: CallMachineRuntimeDeps = {
			...base.deps,
			metrics: { ...base.deps.metrics, recordLatencyFiller } as unknown as CallMachineRuntimeDeps['metrics'],
			director: {
				...base.deps.director,
				streamDraftTokenized: mock.fn((transcript: string) => ({
					userTranscript: transcript,
					events: (async function* () {
						await new Promise((r) => setTimeout(r, 80))
						yield { type: 'token' as const, value: 'Three works.' }
						return 'Three works.'
					})(),
				})),
			} as CallMachineRuntimeDeps['director'],
			latencyFillerMs: 20,
		}
		const engine = createCallMachineRuntime(deps)

		const { outcomePromise } = startCallerTurnComplete(engine, 'what about three', 0.9)
		const outcome = await outcomePromise

		assert.equal(outcome.kind, 'committed')
		if (outcome.kind === 'committed') {
			assert.ok(
				/^(Hmm\.|Let me see\.|One sec\.) Three works\.$/.test(outcome.turn.agentResponse),
				outcome.turn.agentResponse,
			)
		}
		assert.equal(recordLatencyFiller.mock.callCount(), 1)

		engine.stop()
	})

	it('never fills agent-initiated turns', async () => {
		const base = createMockRuntimeDeps()
		const recordLatencyFiller = mock.fn()
		const deps: CallMachineRuntimeDeps = {
			...base.deps,
			metrics: { ...base.deps.metrics, recordLatencyFiller } as unknown as CallMachineRuntimeDeps['metrics'],
			director: {
				...base.deps.director,
				streamDraftTokenized: mock.fn((transcript: string) => ({
					userTranscript: transcript,
					events: (async function* () {
						await new Promise((r) => setTimeout(r, 80))
						yield { type: 'token' as const, value: 'Hi, this is Mimic.' }
						return 'Hi, this is Mimic.'
					})(),
				})),
			} as CallMachineRuntimeDeps['director'],
			latencyFillerMs: 20,
		}
		const engine = createCallMachineRuntime(deps)

		const turnId = engine.actor.getSnapshot().context.nextTurnId
		const outcomePromise = waitForTurnOutcome(engine, turnId)
		engine.sendToCallMachine({ type: 'start_first_turn', openingBlock: 'opening' })
		const outcome = await outcomePromise

		assert.equal(outcome.kind, 'committed')
		if (outcome.kind === 'committed') assert.equal(outcome.turn.agentResponse, 'Hi, this is Mimic.')
		assert.equal(recordLatencyFiller.mock.callCount(), 0)

		engine.stop()
	})
})

describe('call-machine runtime: empty response safety net', () => {
	it('emits a non-committed outcome when the pipeline sends no audio', async () => {
		// `emitAudio: false` makes the fake TTS speaker push zero PCM
		// chunks, so the playback tracker never flips `started` and the
		// pipeline actor reports `stream_empty` instead of `stream_done`.
		const { deps } = createMockRuntimeDeps({ emitAudio: false })
		const engine = createCallMachineRuntime(deps)

		const { outcomePromise } = startCallerTurnComplete(engine, 'Hold on a second', 0.9)
		const result = await outcomePromise

		assert.notEqual(result.kind, 'committed')
		const commitTurn = deps.director.commitTurn as unknown as ReturnType<typeof mock.fn>
		assert.equal(commitTurn.mock.callCount(), 0, 'should not commit an empty assistant response')

		engine.stop()
	})
})

describe('call-machine runtime: event log', () => {
	it('records caller events against the call machine and the emitted turn outcome', async () => {
		const { deps } = createMockRuntimeDeps()
		const eventRecorder = createCallEventRecorder()
		const engine = createCallMachineRuntime({ ...deps, eventRecorder })

		engine.sendToCallMachine({ type: 'vad_speech_start' })
		engine.sendToCallMachine({ type: 'caller_update', transcript: 'can you', confidence: 0.4 })
		engine.sendToCallMachine({ type: 'vad_speech_end' })
		const { turnId, outcomePromise } = startCallerTurnComplete(engine, 'can you hear me', 0.9)
		const result = await outcomePromise
		assert.equal(result.kind, 'committed')

		const events = eventRecorder.snapshot()
		const callEvents = events.filter((e) => e.actor === 'call').map((e) => e.type)
		for (const expected of ['vad_speech_start', 'caller_update', 'vad_speech_end', 'caller_turn_complete']) {
			assert.ok(callEvents.includes(expected), `expected ${expected} in ${callEvents.join(',')}`)
		}
		const complete = events.find((e) => e.type === 'caller_turn_complete' && e.actor === 'call')!
		assert.deepEqual(complete.data, { transcript: 'can you hear me', confidence: 0.9 })

		const outcome = events.find((e) => e.type === 'turn_outcome')!
		assert.equal(outcome.actor, undefined)
		assert.equal(outcome.data.kind, 'committed')
		assert.equal(outcome.data.turnId, turnId)
		assert.equal(outcome.data.userTranscript, 'can you hear me')
		assert.equal(typeof outcome.data.agentResponse, 'string')

		assert.ok(
			events.some((e) => e.type === 'first_audio_sent'),
			'pipeline progress is tapped too',
		)
		for (let i = 1; i < events.length; i++) {
			assert.ok(events[i]!.seq > events[i - 1]!.seq && events[i]!.atMs >= events[i - 1]!.atMs, 'monotonic')
		}

		engine.stop()
	})
})

describe('call-machine runtime: acknowledgements while the agent speaks', () => {
	/** A TTS whose audio only completes when the test says so, keeping the turn in `streaming`. */
	function gatedTts() {
		let release!: () => void
		const audioComplete = new Promise<void>((resolve) => {
			release = resolve
		})
		const tts = {
			connect: mock.fn(async () => {}),
			close: mock.fn(() => {}),
			interrupt: mock.fn(),
			preSendTextForSynthesis: mock.fn(async (_text: string, listener: TtsSynthesisListener) => ({
				pushTextDelta: () => {},
				triggerSynthesisStart: () => listener.onAudioChunk(Buffer.alloc(ttsFrameBytes, 1)),
				audioComplete,
			})),
		} as unknown as CallMachineRuntimeDeps['tts']
		return { tts, release }
	}

	async function resumeOverAcknowledgment(words: string) {
		process.env.MIMIC_SUBSTANTIVE_SPEECH_MS = '20'
		const eventRecorder = createCallEventRecorder()
		const { tts, release } = gatedTts()
		const { deps } = createMockRuntimeDeps({ overrides: { tts, eventRecorder } })
		const engine = createCallMachineRuntime(deps)
		const buildControlBlock = deps.buildControlBlock as unknown as ReturnType<typeof mock.fn>

		const { turnId, outcomePromise } = startCallerTurnComplete(engine, 'what are your hours', 0.9)
		await new Promise((r) => setTimeout(r, 30))
		assert.equal(engine.actor.getSnapshot().value, 'inTurn')

		// The caller acknowledges while the agent is mid-sentence; the agent keeps going.
		engine.sendToCallMachine({ type: 'vad_speech_start' })
		engine.sendToCallMachine({ type: 'caller_turn_start', transcript: words })
		engine.sendToCallMachine({ type: 'caller_update', transcript: words, confidence: 0.5 })
		await new Promise((r) => setTimeout(r, 60))
		assert.equal(engine.actor.getSnapshot().context.resumedOverCallerTurn, true)
		engine.sendToCallMachine({ type: 'vad_speech_end' })

		return { engine, deps, buildControlBlock, eventRecorder, release, turnId, outcomePromise }
	}

	it('drops the end-of-turn of the acknowledgement while still speaking', async () => {
		const { engine, deps, release, turnId, outcomePromise } = await resumeOverAcknowledgment('yeah')
		try {
			const stream = deps.director.streamDraftTokenized as unknown as ReturnType<typeof mock.fn>
			const dropId = engine.actor.getSnapshot().context.nextTurnId
			const dropped = waitForTurnOutcome(engine, dropId)
			engine.sendToCallMachine({ type: 'caller_turn_complete', transcript: 'yeah', confidence: 0.8 })
			const drop = await dropped
			assert.equal(drop.kind, 'discarded')
			if (drop.kind === 'discarded') assert.equal(drop.reason, 'backchannel_handled')
			assert.ok(!stream.mock.calls.some((c) => c.arguments[0] === 'yeah'), 'the director never drafts a reply to it')

			release()
			const original = await outcomePromise
			assert.equal(original.turnId, turnId)
			assert.equal(original.kind, 'committed')
			assert.equal(engine.actor.getSnapshot().context.acknowledgedWhileSpeaking, false, 'nothing left to hint')
		} finally {
			delete process.env.MIMIC_SUBSTANTIVE_SPEECH_MS
			engine.stop()
		}
	})

	it('hands a late acknowledgement end-of-turn to the director with the overlap hint, then clears it', async () => {
		const { engine, buildControlBlock, release, outcomePromise } = await resumeOverAcknowledgment('okay')
		try {
			release()
			const original = await outcomePromise
			assert.equal(original.kind, 'committed')
			assert.equal(engine.actor.getSnapshot().context.acknowledgedWhileSpeaking, true)

			// Flux commits the acknowledgement after the agent has stopped: a real turn, hinted.
			const { outcomePromise: hinted } = startCallerTurnComplete(engine, 'okay', 0.8)
			await hinted
			const call = buildControlBlock.mock.calls.find((c) => c.arguments[0] === 'okay')
			assert.ok(call, 'the director sees the acknowledgement')
			assert.equal((call.arguments[1] as { overlapAcknowledgment?: boolean }).overlapAcknowledgment, true)
			assert.equal(engine.actor.getSnapshot().context.acknowledgedWhileSpeaking, false)

			// The following ordinary turn carries no hint.
			const { outcomePromise: plain } = startCallerTurnComplete(engine, 'and are you open sundays', 0.9)
			await plain
			const plainCall = buildControlBlock.mock.calls.find((c) => c.arguments[0] === 'and are you open sundays')
			assert.equal((plainCall!.arguments[1] as { overlapAcknowledgment?: boolean }).overlapAcknowledgment, false)
		} finally {
			delete process.env.MIMIC_SUBSTANTIVE_SPEECH_MS
			engine.stop()
		}
	})

	it('a new caller turn start clears the hint without a director call', async () => {
		const { engine, deps, release, outcomePromise } = await resumeOverAcknowledgment('right')
		try {
			release()
			await outcomePromise
			assert.equal(engine.actor.getSnapshot().context.acknowledgedWhileSpeaking, true)
			const stream = deps.director.streamDraftTokenized as unknown as ReturnType<typeof mock.fn>
			const before = stream.mock.callCount()

			// No speculation on the acknowledgement; a fresh Flux turn resets the bookkeeping.
			engine.sendToCallMachine({ type: 'caller_eager_turn', transcript: 'right', confidence: 0.8 })
			await new Promise((r) => setTimeout(r, 10))
			assert.equal(stream.mock.callCount(), before, 'no eager draft for the overlapping acknowledgement')
			engine.sendToCallMachine({ type: 'caller_turn_start', transcript: 'so' })
			assert.equal(engine.actor.getSnapshot().context.acknowledgedWhileSpeaking, false)
		} finally {
			delete process.env.MIMIC_SUBSTANTIVE_SPEECH_MS
			engine.stop()
		}
	})
})
