export declare function createMockTtsSessionHarness<TSocket>(createSocket: () => TSocket): {
    session: {
        sessionId: string;
        connect: () => Promise<void>;
        acquireSocket: () => Promise<WebSocket>;
        markSynthesisStart: (contextId: string, abort: () => void) => void;
        markSynthesisEnd: () => void;
        interrupt: () => void;
        shutdown: () => void;
        isIdle: () => boolean;
    };
    sockets: TSocket[];
};
//# sourceMappingURL=tts-session-fixture.d.ts.map