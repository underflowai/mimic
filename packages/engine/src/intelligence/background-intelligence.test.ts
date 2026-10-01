import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import OpenAI from 'openai'

import { createBackgroundIntelligence, type BackgroundIntelligenceDeps } from './background-intelligence.js'

function createMockDeps(overrides?: Partial<BackgroundIntelligenceDeps>): BackgroundIntelligenceDeps {
	const abortController = new AbortController()
	return {
		client: new OpenAI({ apiKey: 'test-key' }),
		callSignal: abortController.signal,
		agentName: 'Aurora',
		transcriber: {
			configure: mock.fn(),
		},
		director: {
			listTurns: () => [],
			needsSummary: () => false,
			getOlderTurnsForSummary: () => null,
			setConversationSummary: () => {},
		},
		...overrides,
	}
}

// ---------------------------------------------------------------------------
// runPostCommitTasks with aborted signal
// ---------------------------------------------------------------------------

describe('runPostCommitTasks', () => {
	it('completes without error when abort signal is already aborted', async () => {
		const abortController = new AbortController()
		abortController.abort()
		const deps = createMockDeps({ callSignal: abortController.signal })
		const bi = createBackgroundIntelligence(deps)

		bi.runPostCommitTasks({
			userTranscript: 'hello',
			agentResponse: 'hi there',
		})
		await bi.drain()
	})

	it('does not call the model when no summary is needed and the call is over', async () => {
		const abortController = new AbortController()
		const create = mock.fn(async () => {
			throw new Error('should not be called')
		})
		const client = { chat: { completions: { create } } } as unknown as OpenAI
		const bi = createBackgroundIntelligence(createMockDeps({ client, callSignal: abortController.signal }))
		abortController.abort()

		bi.runPostCommitTasks({ userTranscript: 'hello', agentResponse: 'hi' })
		await bi.drain()
		assert.equal(create.mock.calls.length, 0)
	})
})

// ---------------------------------------------------------------------------
// drain
// ---------------------------------------------------------------------------

describe('drain', () => {
	it('resolves when no tasks are queued', async () => {
		const bi = createBackgroundIntelligence(createMockDeps())
		await bi.drain()
	})

	it('resolves after aborted tasks', async () => {
		const abortController = new AbortController()
		const deps = createMockDeps({ callSignal: abortController.signal })
		const bi = createBackgroundIntelligence(deps)

		bi.runPostCommitTasks({ userTranscript: 'hello', agentResponse: 'hi' })
		abortController.abort()
		await bi.drain()
	})
})

// ---------------------------------------------------------------------------
// addKeyterms
// ---------------------------------------------------------------------------

describe('addKeyterms', () => {
	it('accumulates terms without error', () => {
		const bi = createBackgroundIntelligence(createMockDeps())
		bi.addKeyterms(['Hartford', 'Markel', 'Dallas'])
		bi.addKeyterms(['Hartford', 'Austin'])
	})
})
