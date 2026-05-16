export function createNoopMetrics() {
    return {
        recordTurnTiming: () => { },
        recordBarge: () => { },
        recordSpeculation: () => { },
        recordSoftPause: () => { },
        recordTurnOutcome: () => { },
        incrementDiscarded: () => { },
        snapshot: () => ({}),
    };
}
//# sourceMappingURL=mock-metrics.js.map