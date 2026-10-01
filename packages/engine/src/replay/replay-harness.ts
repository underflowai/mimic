/**
 * Deterministic call replay.
 *
 * Re-drives the real `CallMachine` + `TurnActor` + eager/early-commit
 * machinery with the recorded event stream from a production call. The
 * LLM/TTS/tool edges are scripted from the log itself:
 *
 *   - the director replays the agent responses the call actually produced
 *     (keyed by user transcript, falling back to commit order)
 *   - the promotion classifier replays recorded speculation outcomes
 *   - TTS/audio are instant fakes (same shape as the machine test mocks)
 *   - tool intent detection is inert (`none`) — replay exercises
 *     turn-taking, not external side effects
 *
 * Time is virtual: the caller supplies a clock (node:test mock timers in
 * regression tests) and the harness advances it between events, so a
 * five-minute call replays in milliseconds with watchdogs, guard windows,
 * and soft-pause timers all firing exactly as they would have.
 *
 * This is how a bad production call becomes a permanent regression test:
 * persist its JSONL, replay it in CI, assert on the outcomes.
 */

import { Writable } from 'node:stream'

import type { AudioSink, AudioTransport } from '../audio/streams/types.js'
import { sanitizeForTts } from '../audio/tts-sanitizer.js'
import { normalizeTranscript } from '../turn/early-commit.js'
import { createCallMachineRuntime, type CallMachineRuntimeDeps } from '../turn/call-machine-runtime.js'
import type { TurnOutcome } from '../turn/types.js'
import { createCallMetrics, withEventRecording } from '../shared/metrics.js'
import { createCallEventRecorder, eventConfidence, eventTranscript, replayableInputTypes, type CallEventRecord } from './event-log.js'

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface ReplayClock {
	/** Advance virtual time by `ms` (e.g. node:test `mock.timers.tick`). */
	tick: (ms: number) => void
}

const drain = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Advance in small steps, draining microtasks so promise chains keep up with timers. */
async function advance(clock: ReplayClock, ms: number) {
	const step = 20
	let remaining = ms
	while (remaining > 0) {
		const delta = Math.min(step, remaining)
		clock.tick(delta)
		remaining -= delta
		await drain()
	}
	await drain()
}

// ---------------------------------------------------------------------------
// Scripted deps
// ---------------------------------------------------------------------------

interface FakeSinkImpl extends AudioSink {
	chunks: Buffer[]
}

function createFakeSink(): FakeSinkImpl {
	const sink = new Writable({ decodeStrings: false, highWaterMark: 1 }) as FakeSinkImpl
	sink.chunks = []
	sink._write = (chunk: Buffer, _enc, cb) => {
		sink.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)))
		cb()
	}
	sink.waitForPlayout = async () => {
		await drain()
	}
	sink.clearQueue = () => {}
	sink.writeFrameDirect = async () => {}
	return sink
}

function createFakeTransport(): AudioTransport {
	return {
		createSink: () => createFakeSink(),
		playBackchannelFrame: () => {},
		isOpen: () => true,
		close: async () => {},
	}
}

function createFakeTts(): CallMachineRuntimeDeps['tts'] {
	return {
		connect: async () => {},
		close: () => {},
		interrupt: () => {},
		preSendTextForSynthesis: async (_text: string, onChunk: (c: Buffer) => void) => ({
			pushTextDelta: () => {},
			triggerSynthesisStart: () => {
				onChunk(Buffer.alloc(1920, 1))
			},
			audioComplete: Promise.resolve(),
		}),
	} as unknown as CallMachineRuntimeDeps['tts']
}

/**
 * Agent responses recorded in the log, replayed by transcript.
 *
 * A single caller turn can trigger several generations (eager draft +
 * racing fresh) that must all see the same text, so lookups peek — the
 * per-transcript cursor advances only when a turn actually commits.
 */
export interface ResponseScript {
	peek: (userTranscript: string) => string
	advanceOn: (userTranscript: string) => void
}

function buildResponseScript(events: CallEventRecord[]): ResponseScript {
	const byTranscript = new Map<string, string[]>()
	const cursorByTranscript = new Map<string, number>()
	const inOrder: string[] = []
	let orderCursor = 0

	for (const event of events) {
		if (event.type !== 'turn_outcome') continue
		const kind = event.data.kind
		const userTranscript =
			typeof event.data.userTranscript === 'string'
				? event.data.userTranscript
				: typeof event.data.transcript === 'string'
					? event.data.transcript
					: ''
		const response =
			typeof event.data.agentResponse === 'string'
				? event.data.agentResponse
				: typeof event.data.fullDraft === 'string'
					? event.data.fullDraft
					: ''
		if (!response) continue
		if (kind !== 'committed' && kind !== 'interrupted') continue
		const key = normalizeTranscript(userTranscript)
		const queue = byTranscript.get(key) ?? []
		queue.push(response)
		byTranscript.set(key, queue)
		inOrder.push(response)
	}

	// The first turn generates from the '[call connected]' pseudo-transcript
	// but commits with an empty user transcript — same script entry.
	function scriptKey(userTranscript: string) {
		const key = normalizeTranscript(userTranscript)
		return key === 'call connected' ? '' : key
	}

	return {
		peek(userTranscript) {
			const key = scriptKey(userTranscript)
			const queue = byTranscript.get(key)
			if (queue && queue.length > 0) {
				const cursor = Math.min(cursorByTranscript.get(key) ?? 0, queue.length - 1)
				return queue[cursor]
			}
			if (orderCursor < inOrder.length) return inOrder[orderCursor]
			return 'Okay.'
		},
		advanceOn(userTranscript) {
			const key = scriptKey(userTranscript)
			const queue = byTranscript.get(key)
			if (queue && queue.length > 0) {
				cursorByTranscript.set(key, (cursorByTranscript.get(key) ?? 0) + 1)
			} else if (orderCursor < inOrder.length) {
				orderCursor++
			}
		},
	}
}

/** Speculation validation results recorded in the log, replayed in order. */
function buildPromotionScript(events: CallEventRecord[]) {
	const outcomes = events
		.filter((event) => event.type === 'speculation')
		.map((event) => event.data.outcome)
		.filter((outcome) => outcome === 'validated_eager' || outcome === 'validation_failed_eager' || outcome === 'promoted')
	let cursor = 0
	return function nextValidation(): boolean {
		if (cursor < outcomes.length) {
			const outcome = outcomes[cursor++]
			return outcome === 'validated_eager' || outcome === 'promoted'
		}
		return true
	}
}

function createScriptedDirector(script: ResponseScript): CallMachineRuntimeDeps['director'] {
	const turns: Array<{ role: 'user' | 'agent'; content: string }> = []
	return {
		streamDraftTokenized: (userTranscript: string) => ({
			userTranscript,
			events: (async function* () {
				const response = script.peek(userTranscript)
				yield { type: 'token' as const, value: response }
				return response
			})(),
		}),
		commitTurn: (content: { kind: string; user?: string; agent?: string; heardAgentPortion?: string }) => {
			if (content.kind === 'exchange') {
				turns.push({ role: 'user', content: content.user ?? '' })
				turns.push({ role: 'agent', content: content.agent ?? '' })
				script.advanceOn(content.user ?? '')
			} else if (content.kind === 'partial_exchange') {
				turns.push({ role: 'user', content: content.user ?? '' })
				turns.push({ role: 'agent', content: content.heardAgentPortion ?? '' })
				script.advanceOn(content.user ?? '')
			} else if (content.kind === 'user_only') {
				turns.push({ role: 'user', content: content.user ?? '' })
			}
		},
		commitToolCall: () => {},
		commitToolResult: () => {},
		listTurns: () => [...turns],
	} as unknown as CallMachineRuntimeDeps['director']
}

/** Watcher client that never proposes tools — replay is side-effect free. */
function createInertWatcherClient(): CallMachineRuntimeDeps['backgroundClient'] {
	return {
		responses: {
			create: async () => ({
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
									reasoning: 'replay: tools inert',
								}),
							},
						],
					},
				],
			}),
		},
	} as unknown as CallMachineRuntimeDeps['backgroundClient']
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface ReplayOptions {
	events: CallEventRecord[]
	clock: ReplayClock
	/** Override runtime deps — the branch point for counterfactual replays. */
	overrides?: Partial<CallMachineRuntimeDeps>
	/** Virtual-time budget to let the machine settle after the last event (default 8s). */
	settleBudgetMs?: number
}

export interface ReplayResult {
	outcomes: TurnOutcome[]
	committedTurns: Array<{ userTranscript: string; agentResponse: string }>
	/** Event log produced by the replay itself (compare against the original). */
	eventLog: CallEventRecord[]
}

export async function replayCall(options: ReplayOptions): Promise<ReplayResult> {
	const { events, clock } = options
	const responseScript = buildResponseScript(events)
	const nextValidation = buildPromotionScript(events)
	const recorder = createCallEventRecorder()
	const transport = createFakeTransport()

	const deps: CallMachineRuntimeDeps = {
		callSignal: new AbortController().signal,
		tts: createFakeTts(),
		specTts: createFakeTts(),
		director: createScriptedDirector(responseScript),
		backgroundClient: createInertWatcherClient(),
		metrics: withEventRecording(createCallMetrics(), (type, data) => recorder.record(type, data)),
		getAudioTransport: () => transport,
		backgroundIntelligence: {
			classifySilenceReason: async () => null,
			runPostCommitTasks: async () => ({ transcriptReliable: true }),
			getLatestPostCommitResults: () => ({ transcriptReliable: true }),
			addKeyterms: () => {},
			drain: async () => {},
		} as unknown as CallMachineRuntimeDeps['backgroundIntelligence'],
		incrementTurn: () => {},
		configureTranscriber: () => {},
		sanitize: sanitizeForTts,
		classifyPromotion: async () => nextValidation(),
		buildControlBlock: (transcript) => `replay control block: ${transcript.slice(0, 60)}`,
		webSearcher: { search: async () => null } as unknown as CallMachineRuntimeDeps['webSearcher'],
		getCallerDateTime: () => undefined,
		getDirectorTurns: () => deps.director.listTurns(),
		onHangupRequest: () => {},
		recordEvent: recorder.record,
		...options.overrides,
	}

	const runtime = createCallMachineRuntime(deps)
	const outcomes: TurnOutcome[] = []
	const committedTurns: Array<{ userTranscript: string; agentResponse: string }> = []
	runtime.actor.on('turn_outcome', ({ outcome }) => {
		outcomes.push(outcome)
		if (outcome.kind === 'committed') {
			committedTurns.push({
				userTranscript: outcome.turn.userTranscript,
				agentResponse: outcome.turn.agentResponse,
			})
		}
	})

	const inputs = events.filter((event) => replayableInputTypes.has(event.type))
	let virtualNow = 0

	for (const input of inputs) {
		const delta = Math.max(0, input.atMs - virtualNow)
		await advance(clock, delta)
		virtualNow = input.atMs

		if (input.type === 'start_first_turn') {
			const openingBlock = typeof input.data.openingBlock === 'string' ? input.data.openingBlock : 'replay opening block'
			runtime.sendToCallMachine({ type: 'start_first_turn', openingBlock })
			continue
		}
		const payload: { type: string; [key: string]: unknown } = { type: input.type }
		const transcript = eventTranscript(input)
		if (transcript) payload.transcript = transcript
		if (input.type === 'caller_turn_resumed' && !transcript) payload.transcript = ''
		const confidence = eventConfidence(input)
		if (confidence) payload.confidence = confidence
		if (input.type === 'transcriber_error') payload.message = typeof input.data.message === 'string' ? input.data.message : ''
		runtime.sendToCallMachine(payload)
	}

	// Let in-flight turns finish under virtual time.
	const settleBudgetMs = options.settleBudgetMs ?? 8_000
	let settled = 0
	while (settled < settleBudgetMs) {
		const snapshot = runtime.actor.getSnapshot()
		if (snapshot.matches('idle') && !runtime.isAgentStreaming()) break
		await advance(clock, 100)
		settled += 100
	}

	runtime.markClosing()
	await drain()
	runtime.stop()
	await drain()

	return { outcomes, committedTurns, eventLog: recorder.snapshot() }
}
