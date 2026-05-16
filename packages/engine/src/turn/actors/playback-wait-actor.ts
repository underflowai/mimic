/**
 * Playback Wait Actor — waits for playback confirmation or caller barge-in.
 *
 * A fromCallback actor invoked by TurnActor's `awaitingPlayback` state.
 * Listens for two events via `receive`:
 *   - `playback_confirmed` — caller confirmed audio played
 *   - `caller_turn_start` — caller started speaking (barge-in commit)
 *
 * On either event, sends back `{ type: 'playback_settled' }` so TurnActor
 * can transition to `committing`.
 */

import { fromCallback } from 'xstate'

export type PlaybackWaitSendEvent = {
	type: 'playback_settled'
	triggeredBy: 'playback_confirmed' | 'caller_turn_start'
}

export const playbackWaitActor = fromCallback<PlaybackWaitSendEvent, Record<string, never>>(({ sendBack, receive }) => {
	receive((event) => {
		const type = (event as { type: string }).type
		if (type === 'playback_confirmed' || type === 'caller_turn_start') {
			sendBack({ type: 'playback_settled', triggeredBy: type })
		}
	})
})
