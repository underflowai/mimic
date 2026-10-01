import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'

import { parseEventLog } from './event-log.js'
import { replayCall } from './replay-harness.js'

const fixture = () =>
	parseEventLog(readFileSync(new URL('./fixtures/confirmation-call.jsonl', import.meta.url), 'utf8'))

describe('replay harness', () => {
	beforeEach(() => {
		// Positive epoch — parts of the runtime treat Date.now() === 0 as "unset".
		mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
	})

	afterEach(() => {
		mock.timers.reset()
	})

	it('replays a recorded call deterministically: same turns, same responses', async () => {
		const events = fixture()
		const result = await replayCall({
			events,
			clock: { tick: (ms) => mock.timers.tick(ms) },
		})

		assert.equal(result.committedTurns.length, 3, `expected 3 committed turns, got ${JSON.stringify(result.committedTurns)}`)
		assert.equal(result.committedTurns[0].agentResponse, 'Hey Dan — this is Aurora from Acme Dental.')
		assert.equal(result.committedTurns[1].userTranscript, "yeah hi what's this about")
		assert.equal(
			result.committedTurns[1].agentResponse,
			'So — quick thing about your Tuesday appointment. Does two PM still work?',
		)
		assert.equal(result.committedTurns[2].agentResponse, "Great, you're all set for Tuesday. Bye now!")

		const discarded = result.outcomes.filter((o) => o.kind === 'discarded' && o.reason === 'failed')
		assert.equal(discarded.length, 0, 'no failed turns during replay')
	})

	it('produces its own event log for divergence comparison', async () => {
		const result = await replayCall({
			events: fixture(),
			clock: { tick: (ms) => mock.timers.tick(ms) },
		})

		const types = new Set(result.eventLog.map((e) => e.type))
		assert.ok(types.has('caller_turn_complete'), 'replay log records caller finals')
		assert.ok(types.has('turn_outcome'), 'replay log records turn outcomes')
		assert.ok(types.has('turn_timing'), 'replay log records turn timings')

		const committedOutcomes = result.eventLog.filter(
			(e) => e.type === 'turn_outcome' && e.data.kind === 'committed',
		)
		assert.equal(committedOutcomes.length, 3)
	})
})
