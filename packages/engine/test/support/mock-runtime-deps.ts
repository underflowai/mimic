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

import { ttsFrameBytes } from '#engine/shared/audio-pacing.js'
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
		speakAndWait: mock.fn(async (_text: string, onChunk: (c: Buffer) => void) => {
			if (emitAudio) onChunk(Buffer.alloc(ttsFrameBytes, 1))
		}),
		preSendTextForSynthesis: mock.fn(async (_text: string, onChunk: (c: Buffer) => void) => ({
			pushTextDelta: () => {},
			triggerSynthesisStart: () => {
				if (emitAudio) onChunk(Buffer.alloc(ttsFrameBytes, 1))
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
			classifySilenceReason: mock.fn(),
			runPostCommitTasks: mock.fn(async () => ({ transcriptReliable: true })),
			getLatestPostCommitResults: mock.fn(() => ({ transcriptReliable: true })),
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
		onSilenceHangup: mock.fn(),
		...options.overrides,
	}

	return { deps, transport }
}
