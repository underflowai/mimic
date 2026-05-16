import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { createFakeAudioTransport } from '#test/support/fake-audio-transport.js'
import { createCallMachineRuntime, type CallMachineRuntimeDeps, type TurnOutcome } from './call-machine-runtime.js'

function waitForOutcome(engine: ReturnType<typeof createCallMachineRuntime>, turnId: number) {
	return new Promise<TurnOutcome>((resolve) => {
		const sub = engine.actor.on('turn_outcome', ({ outcome }) => {
			if (outcome.turnId !== turnId) return
			sub.unsubscribe()
			resolve(outcome)
		})
	})
}

function createDeps() {
	const transport = createFakeAudioTransport()
	const streamTokenizedTranscripts: string[] = []
	const streamTokenizedBlocks: string[] = []

	const deps: CallMachineRuntimeDeps = {
		callSignal: new AbortController().signal,
		tts: {
			interrupt: mock.fn(),
			connect: mock.fn(async () => {}),
			close: mock.fn(),
			preSendTextForSynthesis: mock.fn(async () => ({
				pushTextDelta: () => {},
				triggerSynthesisStart: () => {},
				audioComplete: Promise.resolve(),
			})),
		} as CallMachineRuntimeDeps['tts'],
		specTts: {
			interrupt: mock.fn(),
			connect: mock.fn(async () => {}),
			close: mock.fn(),
			preSendTextForSynthesis: mock.fn(async () => ({
				pushTextDelta: () => {},
				triggerSynthesisStart: () => {},
				audioComplete: Promise.resolve(),
			})),
		} as CallMachineRuntimeDeps['specTts'],
		getAudioTransport: () => transport,
		configureTranscriber: mock.fn(),
		director: {
			generateDraft: mock.fn(async (transcript: string) => ({ userTranscript: transcript, agentResponse: 'draft' })),
			streamDraftTokenized: mock.fn((transcript: string, controlBlock: string) => {
				streamTokenizedTranscripts.push(transcript)
				streamTokenizedBlocks.push(controlBlock)
				return {
					userTranscript: transcript,
					events: (async function* () {
						yield { type: 'token' as const, value: 'response' }
						return 'response'
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
			recordSpeculation: mock.fn(),
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
		classifyPromotion: mock.fn(async () => false),
		buildControlBlock: mock.fn((transcript: string) => `[briefing] caller said: ${transcript}`),
		webSearcher: { search: mock.fn(async () => null) } as CallMachineRuntimeDeps['webSearcher'],
		getCallerDateTime: () => undefined,
		getDirectorTurns: () => [],
		onSilenceHangup: mock.fn(),
	}

	return { deps, streamTokenizedTranscripts, streamTokenizedBlocks }
}

describe('fresh turn flow', () => {
	it('fresh turn receives transcript and controlBlock from completeCallerTurn', async () => {
		const { deps, streamTokenizedTranscripts, streamTokenizedBlocks } = createDeps()
		const engine = createCallMachineRuntime(deps)

		const fullTranscript = 'Not much just wanna learn more about what you guys do at Underflow'
		const turnId = engine.actor.getSnapshot().context.nextTurnId
		const turnPromise = waitForOutcome(engine, turnId)
		engine.sendToCallMachine({
			type: 'caller_turn_complete',
			transcript: fullTranscript,
			confidence: 0.93,
		})
		await turnPromise

		const lastIdx = streamTokenizedTranscripts.length - 1
		assert.ok(lastIdx >= 0, 'streamDraftTokenized should have been called for the turn')
		assert.equal(streamTokenizedTranscripts[lastIdx], fullTranscript)
		assert.ok(streamTokenizedBlocks[lastIdx]?.includes(fullTranscript))

		engine.stop()
	})
})
