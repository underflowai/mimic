import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { createActor } from 'xstate'

import { commitActorLogic, type CommitActorDeps, type CommitActorInput } from './commit-actor.js'

function makeDeps(): CommitActorDeps & { calls: string[]; committed: Array<{ kind: string; agent?: string }> } {
	const calls: string[] = []
	const committed: Array<{ kind: string; agent?: string }> = []
	return {
		calls,
		committed,
		director: {
			commitTurn: mock.fn((content: { kind: string; user?: string; userSnapshot?: string; agent?: string }) => {
				committed.push(content)
				const userText = content.user ?? content.userSnapshot ?? ''
				calls.push(`commitTurn:${content.kind}:${userText.slice(0, 20)}`)
			}),
		},
		incrementTurn: mock.fn(() => {
			calls.push('incrementTurn')
		}),
		metrics: {
			recordTurnTiming: mock.fn(() => {
				calls.push('recordTurnTiming')
			}),
		},
	}
}

function makeInput(deps: CommitActorDeps, overrides?: Partial<CommitActorInput>): CommitActorInput {
	return {
		turnId: 1,
		userTranscript: 'what are the rates',
		agentResponse: 'Here are the rates.',
		generationStartedAt: 100,
		generationToAudioCompleteMs: 50,
		firstAudioAt: 200,
		endCallRequested: false,
		ttsFirstByteMs: null,
		llmFirstTokenMs: null,
		llmCompleteMs: null,
		timingKind: 'fresh',
		lastTurnCompleteAt: 90,
		lastVadSpeechEndAt: 80,
		deps,
		...overrides,
	}
}

async function runCommitActor(input: CommitActorInput) {
	return new Promise<unknown>((resolve, reject) => {
		const actor = createActor(commitActorLogic, { input })
		actor.subscribe((snap) => {
			if (snap.status === 'done') resolve(snap.output)
			if (snap.status === 'error') reject(snap.error)
		})
		actor.start()
	})
}

describe('commitActorLogic', () => {
	it('commits a normal exchange via commitTurn', async () => {
		const deps = makeDeps()
		const output = await runCommitActor(makeInput(deps))
		assert.ok(output)
		const { committedTurn } = output as { committedTurn: { turnId: number; userTranscript: string } }
		assert.equal(committedTurn.turnId, 1)
		assert.equal(committedTurn.userTranscript, 'what are the rates')
		assert.ok(deps.calls.includes('commitTurn:exchange:what are the rates'))
		assert.ok(deps.calls.includes('incrementTurn'))
		assert.ok(deps.calls.includes('recordTurnTiming'))
	})

	it('commits a greeting when userTranscript is empty', async () => {
		const deps = makeDeps()
		const output = await runCommitActor(makeInput(deps, { userTranscript: '' }))
		assert.ok(output)
		assert.ok(deps.calls.includes('commitTurn:greeting:'))
	})

	it('commits human-spoken text as the agent transcript', async () => {
		const deps = makeDeps()
		const output = await runCommitActor(
			makeInput(deps, {
				agentResponse:
					'[say warmly with a calm, professional tone] I can <giggle> demo this and <slow-extra>not this</slow-extra>. {"date":"next Wednesday"}',
			}),
		)

		assert.ok(output)
		const { committedTurn } = output as { committedTurn: { agentResponse: string } }
		assert.equal(committedTurn.agentResponse, 'I can demo this and not this.')
		assert.equal(deps.committed[0]?.agent, committedTurn.agentResponse)
	})

	it('records timing metrics with correct values', async () => {
		const deps = makeDeps()
		const output = await runCommitActor(
			makeInput(deps, {
				generationStartedAt: 100,
				firstAudioAt: 250,
				lastTurnCompleteAt: 90,
				generationToAudioCompleteMs: 50,
			}),
		)
		assert.ok(output)
		const recordFn = deps.metrics.recordTurnTiming as unknown as ReturnType<typeof mock.fn>
		const recordCall = recordFn.mock.calls[0]
		assert.ok(recordCall)
		const timing = recordCall.arguments[0] as {
			turnId: number
			generationToAudioCompleteMs: number
			generationToFirstAudioMs: number | null
			turnCompleteToFirstAudioMs: number | null
			vadEndToTurnCompleteMs: number | null
			vadEndToFirstAudioMs: number | null
		}
		assert.equal(timing.turnId, 1)
		assert.equal(timing.generationToAudioCompleteMs, 50)
		assert.equal(timing.generationToFirstAudioMs, 150)
		assert.equal(timing.turnCompleteToFirstAudioMs, 160)
		assert.equal(timing.vadEndToTurnCompleteMs, 10)
		assert.equal(timing.vadEndToFirstAudioMs, 170)
	})

	it('omits VAD metrics when no VAD speech end was observed', async () => {
		const deps = makeDeps()
		const output = await runCommitActor(
			makeInput(deps, {
				generationStartedAt: 100,
				firstAudioAt: 250,
				lastTurnCompleteAt: 90,
				lastVadSpeechEndAt: 0,
				generationToAudioCompleteMs: 50,
			}),
		)
		assert.ok(output)
		const recordFn = deps.metrics.recordTurnTiming as unknown as ReturnType<typeof mock.fn>
		const recordCall = recordFn.mock.calls[0]
		assert.ok(recordCall)
		const timing = recordCall.arguments[0] as {
			vadEndToTurnCompleteMs: number | null
			vadEndToFirstAudioMs: number | null
		}
		assert.equal(timing.vadEndToTurnCompleteMs, null)
		assert.equal(timing.vadEndToFirstAudioMs, null)
	})
})
