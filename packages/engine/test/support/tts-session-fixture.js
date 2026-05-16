import { createTtsSocketSession } from '#engine/audio/tts-session.js';
export function createMockTtsSessionHarness(createSocket) {
    const sockets = [];
    const session = createTtsSocketSession({
        buildUrl: () => 'wss://test',
        buildHeaders: () => ({ 'X-API-Key': 'test' }),
        createWebSocket: () => {
            const socket = createSocket();
            sockets.push(socket);
            return socket;
        },
    });
    return { session, sockets };
}
//# sourceMappingURL=tts-session-fixture.js.map