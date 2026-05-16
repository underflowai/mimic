/**
 * Regression coverage for eager TTS isolation.
 *
 * Predictive/eager pre-synthesis must use the secondary speculation speaker
 * (`specTts`), never the primary turn speaker. That prevents speculative work
 * from superseding the active turn actor's TTS session.
 */

import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { createFakeAudioTransport } from '#test/support/fake-audio-transport.js'
import { waitForCondition } from '#test/support/wait-for-condition.js'
import { createCallMachineRuntime, type CallMachineRuntimeDeps } from './call-machine-runtime.js'

function createDeps() {
	const primaryTtsTexts: string[] = []
	const specTtsTexts: string[] = []
	const transport = createFakeAudioTransport()

	const deps: CallMachineRuntimeDeps = {
		callSignal: new AbortController().signal,
		tts: {
			interrupt: mock.fn(),
			connect: mock.fn(async () => {}),
			close: mock.fn(),
			preSendTextForSynthesis: mock.fn(async (text: string) => {
				primaryTtsTexts.push(text)
				return {
					pushTextDelta: () => {},
					triggerSynthesisStart: () => {},
					audioComplete: Promise.resolve(),
				}
			}),
		} as CallMachineRuntimeDeps['tts'],
		specTts: {
			interrupt: mock.fn(),
			connect: mock.fn(async () => {}),
			close: mock.fn(),
			preSendTextForSynthesis: mock.fn(async (text: string) => {
				specTtsTexts.push(text)
				return {
					pushTextDelta: () => {},
					triggerSynthesisStart: () => {},
					audioComplete: Promise.resolve(),
				}
			}),
		} as CallMachineRuntimeDeps['specTts'],
		director: {
			generateDraft: mock.fn(async (transcript: string) => ({
				userTranscript: transcript,
				agentResponse: `eager response for ${transcript}`,
			})),
			streamDraftTokenized: mock.fn((transcript: string) => ({
				userTranscript: transcript,
				events: (async function* () {
					yield { type: 'token' as const, value: 'fresh' }
					return 'fresh'
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
		configureTranscriber: mock.fn(),
		backgroundIntelligence: {
			runPostCommitTasks: mock.fn(async () => {}),
			addKeyterms: mock.fn(),
			drain: mock.fn(async () => {}),
		} as unknown as CallMachineRuntimeDeps['backgroundIntelligence'],
		incrementTurn: mock.fn(),
		sanitize: (text: string) => text,
		classifyPromotion: mock.fn(async () => true),
		buildControlBlock: mock.fn(() => 'mock control block'),
		webSearcher: { search: mock.fn(async () => null) } as CallMachineRuntimeDeps['webSearcher'],
		getCallerDateTime: () => undefined,
		getDirectorTurns: () => [],
		onSilenceHangup: mock.fn(),
	}

	return { deps, primaryTtsTexts, specTtsTexts }
}

describe('TTS race: eager pipeline uses secondary TTS', () => {
	it('eager streaming sends tokenized text on specTts without touching primary TTS', async () => {
		const { deps, primaryTtsTexts, specTtsTexts } = createDeps()
		const engine = createCallMachineRuntime(deps)

		engine.sendToCallMachine({
			type: 'caller_eager_turn',
			transcript: 'I work at a car dealership in Pasadena',
			confidence: 0.9,
		})

		await waitForCondition(() => specTtsTexts.length === 1, 500)
		assert.deepEqual(specTtsTexts, ['fresh'])
		assert.deepEqual(primaryTtsTexts, [])

		engine.stop()
	})
})
