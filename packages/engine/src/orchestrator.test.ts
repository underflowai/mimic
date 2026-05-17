import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.OPENAI_API_KEY ??= 'test-openai-key'

// ---------------------------------------------------------------------------
// Orchestrator lifecycle
// ---------------------------------------------------------------------------

function stubCallbacks() {
	return {
		buildOpeningBlock: () => 'Opening block for test',
		buildTurnControlBlock: () => 'Turn control block for test',
	}
}

describe('createCallOrchestrator', () => {
	it('configure updates caller config', async () => {
		const { createCallOrchestrator } = await import('./orchestrator.js')
		const orch = await createCallOrchestrator({
			systemPrompt: 'You are Aurora.',
			userFirstName: 'Alice',
			...stubCallbacks(),
		})
		orch.configure({ userFirstName: 'Bob' })
		orch.configure({ userTimezone: 'America/New_York' })
		assert.ok(orch, 'orchestrator should be created and configured without throwing')
		await orch.close()
	})

	it('close without start returns expected shape', async () => {
		const { createCallOrchestrator } = await import('./orchestrator.js')
		const orch = await createCallOrchestrator({
			systemPrompt: 'You are Aurora.',
			userFirstName: 'Alice',
			...stubCallbacks(),
		})
		const result = await orch.close()
		assert.ok(Array.isArray(result.turns))
		assert.equal(result.turns.length, 0)
		assert.equal(typeof result.turnCount, 'number')
		assert.equal(typeof result.durationSeconds, 'number')
		assert.ok(result.metrics)
		assert.ok(Array.isArray(result.metrics.turnTimings))
		assert.ok(Array.isArray(result.metrics.bargeEvents))
		assert.ok(Array.isArray(result.metrics.speculationEvents))
		assert.equal(typeof result.metrics.discardedTurns, 'number')
	})

	it('hangup callback can be registered', async () => {
		const { createCallOrchestrator } = await import('./orchestrator.js')
		const orch = await createCallOrchestrator({
			systemPrompt: 'You are Aurora.',
			userFirstName: 'Alice',
			...stubCallbacks(),
		})
		orch.onHangupRequested(() => {})
		assert.ok(true, 'registering callbacks should not throw')
		await orch.close()
	})
})
