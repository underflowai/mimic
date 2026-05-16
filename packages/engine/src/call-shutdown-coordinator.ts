/**
 * Call Shutdown Coordinator
 *
 * Deterministic teardown for a voice call. Idempotent: repeated `close()`
 * calls return the same promise (and therefore the same settled result).
 * Teardown order:
 *
 *   1. markClosing()             — gate new work
 *   2. abortCall()               — propagate cancellation
 *   3. interruptActiveTurn()     — stop in-flight TTS/generation
 *   4. resetToolCoordinator()    — supersede pending tool tasks
 *   5. shutdownRuntime()         — close transcriber, TTS, VAD, listeners
 *   6. drainBackgroundIntelligence() — flush queued post-commit tasks
 *   7. publishMetrics(snapshot)  — emit summary telemetry
 *
 * If `shutdownRuntime` throws, drain still runs and the error is surfaced
 * once metrics have been captured. Callers can assume teardown always
 * reaches step 6 regardless of upstream failures.
 */

interface ShutdownLogger {
	info: (...args: unknown[]) => void
}

interface MetricsSnapshotLike {
	readonly turnTimings: readonly unknown[]
	readonly bargeEvents: readonly unknown[]
	readonly speculationEvents: ReadonlyArray<{ outcome: string; speculationDurationMs: number }>
	readonly softPauseEvents: readonly unknown[]
	readonly turnOutcomes: readonly unknown[]
	readonly discardedTurns: number
}

export interface CallShutdownResult<TTurn, TMetricsSnapshot> {
	turns: TTurn[]
	turnCount: number
	durationSeconds: number
	metrics: TMetricsSnapshot
}

export interface CallShutdownCoordinatorDeps<TTurn, TMetricsSnapshot extends MetricsSnapshotLike, TSummary> {
	log: ShutdownLogger
	startTimeMs: number
	nowMs?: () => number
	markClosing: () => void
	abortCall: () => void
	interruptActiveTurn: () => void
	resetToolCoordinator: () => void
	shutdownRuntime: () => Promise<void>
	drainBackgroundIntelligence: () => Promise<void>
	listTurns: () => TTurn[]
	getBriefingTurnCount: () => number
	snapshotMetrics: () => TMetricsSnapshot
	summarizeMetrics: () => TSummary
	publishMetrics?: (snapshot: TMetricsSnapshot, durationSeconds: number) => void
}

export function createCallShutdownCoordinator<TTurn, TMetricsSnapshot extends MetricsSnapshotLike, TSummary>(
	deps: CallShutdownCoordinatorDeps<TTurn, TMetricsSnapshot, TSummary>,
) {
	const nowMs = deps.nowMs ?? Date.now

	let closePromise: Promise<CallShutdownResult<TTurn, TMetricsSnapshot>> | null = null

	async function doClose() {
		deps.markClosing()
		deps.abortCall()
		deps.interruptActiveTurn()
		deps.resetToolCoordinator()

		let runtimeError: unknown = null
		try {
			await deps.shutdownRuntime()
		} catch (err) {
			runtimeError = err
		}
		await deps.drainBackgroundIntelligence()

		const turns = deps.listTurns()
		const snapshot = deps.snapshotMetrics()

		const speculations = snapshot.speculationEvents
		if (speculations.length > 0) {
			const promoted = speculations.filter(
				(event) => event.outcome === 'validated_eager' || event.outcome === 'promoted',
			)
			const validationAttempts = speculations.filter(
				(event) =>
					event.outcome === 'validated_eager' ||
					event.outcome === 'validation_failed_eager' ||
					event.outcome === 'promoted',
			)
			const byOutcome = Object.fromEntries(
				[...new Set(speculations.map((event) => event.outcome))].map((outcome) => [
					outcome,
					speculations.filter((event) => event.outcome === outcome).length,
				]),
			)
			const avgSavedMs =
				promoted.length > 0
					? Math.round(promoted.reduce((sum, event) => sum + event.speculationDurationMs, 0) / promoted.length)
					: 0
			deps.log.info(
				{
					promoted: promoted.length,
					total: validationAttempts.length,
					hitRate: validationAttempts.length > 0 ? promoted.length / validationAttempts.length : 0,
					byOutcome,
					avgSavedMs,
				},
				'speculation summary',
			)
		}

		if (snapshot.turnTimings.length > 0) {
			deps.log.info(deps.summarizeMetrics(), 'call latency summary')
		}

		deps.log.info({ turnCount: turns.length }, 'call ended')

		const durationSeconds = Math.round((nowMs() - deps.startTimeMs) / 1000)
		deps.publishMetrics?.(snapshot, durationSeconds)

		if (runtimeError) throw runtimeError

		return {
			turns,
			turnCount: deps.getBriefingTurnCount(),
			durationSeconds,
			metrics: snapshot,
		}
	}

	function close() {
		if (!closePromise) closePromise = doClose()
		return closePromise
	}

	return { close }
}

export type CallShutdownCoordinator = ReturnType<typeof createCallShutdownCoordinator>
