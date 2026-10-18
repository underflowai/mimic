import { RoomEvent, type Room } from '@livekit/rtc-node'

export type CallerWaitRoom = Pick<Room, 'once' | 'off'>

/**
 * Resolve when the first remote participant joins. Rejects if the room
 * disconnects first or, when `timeoutMs` is set, if nobody arrives in time.
 * Without a timeout the wait is open-ended, which is right for SIP: the leg
 * is already in the room by the time the agent connects.
 */
export function waitForCaller(room: CallerWaitRoom, timeoutMs?: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | null = null
		const cleanup = () => {
			room.off(RoomEvent.ParticipantConnected, onJoin)
			room.off(RoomEvent.Disconnected, onDisconnect)
			if (timer) clearTimeout(timer)
		}
		const onJoin = () => {
			cleanup()
			resolve()
		}
		const onDisconnect = () => {
			cleanup()
			reject(new Error('room disconnected before caller joined'))
		}
		room.once(RoomEvent.ParticipantConnected, onJoin)
		room.once(RoomEvent.Disconnected, onDisconnect)
		if (timeoutMs !== undefined) {
			timer = setTimeout(() => {
				cleanup()
				reject(new Error(`No one joined the call within ${Math.round(timeoutMs / 1000)} seconds`))
			}, timeoutMs)
		}
	})
}
