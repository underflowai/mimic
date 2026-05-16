import { subscribeToCall } from '../call-runner.js'

export function handleStreamUpgrade(callId: string, _token: string) {
	return {
		onOpen(_event: unknown, ws: { send: (data: string) => void }) {
			const unsubscribe = subscribeToCall(callId, (event) => {
				try {
					ws.send(JSON.stringify(event))
				} catch {}
			})

			;(ws as unknown as { _unsub: () => void })._unsub = unsubscribe
		},

		onMessage(_event: unknown, _ws: unknown) {},

		onClose(_event: unknown, ws: unknown) {
			const unsub = (ws as { _unsub?: () => void })._unsub
			unsub?.()
		},
	}
}
