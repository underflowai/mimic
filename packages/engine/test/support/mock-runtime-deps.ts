/**
 * Shared mock-deps builder for call-machine-runtime tests.
 *
 * Provides:
 *   - a fake `AudioTransport` that collects written PCM chunks,
 *   - a fake TTS speaker that emits a single frame per synthesis,
 *   - a minimal director / metrics / search stack.
 *
 * Tests can override individual deps via the `overrides` argument.
 */

import { mock } from 'node:test'

import type { TtsSynthesisListener } from '#engine/audio/tts-speaker.js'
import { ttsFrameBytes } from '#engine/shared/audio-format.js'
import type { CallMachineRuntimeDeps } from '#engine/turn/call-machine-runtime.js'

import { createFakeAudioTransport, type FakeAudioTransport } from './fake-audio-transport.js'

export interface MockRuntimeBuildOptions {
	overrides?: Partial<CallMachineRuntimeDeps>
	emitAudio?: boolean
}

export interface MockRuntimeBundle {
	deps: CallMachineRuntimeDeps
	transport: FakeAudioTransport
}

function makeFakeTts(emitAudio: boolean) {
	return {
		connect: mock.fn(async () => {}),
		close: mock.fn(() => {}),
		interrupt: mock.fn(),
		preSendTextForSynthesis: mock.fn(async (_text: string, listener: TtsSynthesisListener) => ({
			pushTextDelta: () => {},
			triggerSynthesisStart: () => {
				if (emitAudio) listener.onAudioChunk(Buffer.alloc(ttsFrameBytes, 1))
			},
			audioComplete: Promise.resolve(),
		})),
	} as unknown as CallMachineRuntimeDeps['tts']
}

export function createMockRuntimeDeps(options: MockRuntimeBuildOptions = {}): MockRuntimeBundle {
	const emitAudio = options.emitAudio ?? true
	const transport = createFakeAudioTransport()

	const deps: CallMachineRuntimeDeps = {
		callSignal: new AbortController().signal,
		tts: makeFakeTts(emitAudio),
		specTts: makeFakeTts(emitAudio),
		director: {
			generateDraft: mock.fn(async (transcript: string) => ({
				userTranscript: transcript,
				agentResponse: 'mock response',
			})),
			streamDraftTokenized: mock.fn((transcript: string) => ({
				userTranscript: transcript,
				events: (async function* () {
					yield { type: 'token' as const, value: 'mock response' }
					return 'mock response'
				})(),
			})),
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
			recordSpeculation: mock.fn(),
			recordSoftPause: mock.fn(),
			recordTurnOutcome: mock.fn(),
			recordTurnTiming: mock.fn(),
			incrementDiscarded: mock.fn(),
		} as unknown as CallMachineRuntimeDeps['metrics'],
		getAudioTransport: () => transport,
		backgroundIntelligence: {
			runPostCommitTasks: mock.fn(() => {}),
			addKeyterms: mock.fn(),
			drain: mock.fn(async () => {}),
		} as unknown as CallMachineRuntimeDeps['backgroundIntelligence'],
		incrementTurn: mock.fn(),
		configureTranscriber: mock.fn(),
		sanitize: (text: string) => text,
		classifyPromotion: mock.fn(async () => false),
		buildControlBlock: mock.fn(() => 'mock control block'),
		webSearcher: { search: mock.fn(async () => null) } as CallMachineRuntimeDeps['webSearcher'],
		getCallerDateTime: () => undefined,
		getDirectorTurns: () => [],
		endCallEnabled: false,
		onHangupRequested: mock.fn(),
		...options.overrides,
	}

	return { deps, transport }
}
