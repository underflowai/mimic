import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { createMockRuntimeDeps } from '#test/support/mock-runtime-deps.js'
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
