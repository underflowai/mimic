import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { createCallShutdownCoordinator } from './call-shutdown-coordinator.js'

describe('createCallShutdownCoordinator', () => {
	it('runs shutdown sequence and returns close summary', async () => {
		const order: string[] = []
		const logInfo = mock.fn((..._args: unknown[]) => {})
		const snapshot = {
			turnTimings: [{ turnId: 1 }],
			bargeEvents: [],
			speculationEvents: [
				{ outcome: 'promoted', speculationDurationMs: 180 },
				{ outcome: 'discarded_timeout', speculationDurationMs: 90 },
			],
			softPauseEvents: [],
			turnOutcomes: [],
			discardedTurns: 1,
		}

		const publishMetrics = mock.fn((..._args: unknown[]) => {})

		const coordinator = createCallShutdownCoordinator({
			log: { info: logInfo },
			startTimeMs: 1_000,
			nowMs: () => 31_000,
			markClosing: () => order.push('markClosing'),
			abortCall: () => order.push('abortCall'),
			interruptActiveTurn: () => order.push('interrupt:call_ended'),
			resetToolCoordinator: () => order.push('resetTool'),
			shutdownRuntime: async () => {
				order.push('shutdownRuntime')
			},
			drainBackgroundIntelligence: async () => {
				order.push('drainBackgroundIntelligence')
			},
			listTurns: () => [{ role: 'user', content: 'hi' }],
			getBriefingTurnCount: () => 4,
			snapshotMetrics: () => snapshot,
			summarizeMetrics: () => ({ turns: 1 }),
			publishMetrics,
		})

		const result = await coordinator.close()

		assert.deepEqual(order, [
			'markClosing',
			'abortCall',
			'interrupt:call_ended',
			'resetTool',
			'shutdownRuntime',
			'drainBackgroundIntelligence',
		])
		assert.equal(result.turns.length, 1)
		assert.equal(result.turnCount, 4)
		assert.equal(result.durationSeconds, 30)
		assert.equal(result.metrics, snapshot)
		assert.equal(logInfo.mock.calls.length, 3)
		assert.equal(logInfo.mock.calls[0]!.arguments[1], 'speculation summary')
		assert.equal(logInfo.mock.calls[1]!.arguments[1], 'call latency summary')
		assert.equal(logInfo.mock.calls[2]!.arguments[1], 'call ended')
		assert.equal(publishMetrics.mock.calls.length, 1)
		assert.equal(publishMetrics.mock.calls[0]!.arguments[0], snapshot)
		assert.equal(publishMetrics.mock.calls[0]!.arguments[1], 30)
	})

	it('skips optional summary logs when there is no data', async () => {
		const logInfo = mock.fn((..._args: unknown[]) => {})
		const coordinator = createCallShutdownCoordinator({
			log: { info: logInfo },
			startTimeMs: 0,
			nowMs: () => 1_000,
			markClosing: () => {},
			abortCall: () => {},
			interruptActiveTurn: () => {},
			resetToolCoordinator: () => {},
			shutdownRuntime: async () => {},
			drainBackgroundIntelligence: async () => {},
			listTurns: () => [],
			getBriefingTurnCount: () => 0,
			snapshotMetrics: () => ({
				turnTimings: [],
				bargeEvents: [],
				speculationEvents: [],
				softPauseEvents: [],
				turnOutcomes: [],
				discardedTurns: 0,
			}),
			summarizeMetrics: () => ({}),
		})

		await coordinator.close()
		assert.equal(logInfo.mock.calls.length, 1)
		assert.equal(logInfo.mock.calls[0]!.arguments[1], 'call ended')
	})

	it('still drains background intelligence when runtime shutdown throws', async () => {
		const order: string[] = []
		const coordinator = createCallShutdownCoordinator({
			log: { info: () => {} },
			startTimeMs: 0,
			nowMs: () => 1_000,
			markClosing: () => order.push('markClosing'),
			abortCall: () => order.push('abortCall'),
			interruptActiveTurn: () => order.push('interrupt'),
			resetToolCoordinator: () => order.push('resetTool'),
			shutdownRuntime: async () => {
				order.push('shutdownRuntime')
				throw new Error('shutdown failed')
			},
			drainBackgroundIntelligence: async () => {
				order.push('drainBackgroundIntelligence')
			},
			listTurns: () => [],
			getBriefingTurnCount: () => 0,
			snapshotMetrics: () => ({
				turnTimings: [],
				bargeEvents: [],
				speculationEvents: [],
				softPauseEvents: [],
				turnOutcomes: [],
				discardedTurns: 0,
			}),
			summarizeMetrics: () => ({}),
		})

		await assert.rejects(() => coordinator.close(), /shutdown failed/)
		assert.deepEqual(order, [
			'markClosing',
			'abortCall',
			'interrupt',
			'resetTool',
			'shutdownRuntime',
			'drainBackgroundIntelligence',
		])
	})
})
