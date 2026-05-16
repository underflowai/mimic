import { createTtsSocketSession } from '#engine/audio/tts-session.js'

export function createMockTtsSessionHarness<TSocket>(createSocket: () => TSocket) {
	const sockets: TSocket[] = []
	const session = createTtsSocketSession({
		buildUrl: () => 'wss://test',
		buildHeaders: () => ({ 'X-API-Key': 'test' }),
		createWebSocket: () => {
			const socket = createSocket()
			sockets.push(socket)
			return socket as unknown as WebSocket
		},
	})
	return { session, sockets }
}
