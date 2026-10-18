import type { MimicClient } from './client.js'
import { MimicError } from './errors.js'
import type { CallEvent, ServerMessage, WebSocketConstructor } from './types.js'

/**
 * Watch a call that already exists, from any process. Yields `speech`,
 * `status`, `error`, and `done` events and returns once the call has ended;
 * a call that ended before you connected yields its final status and returns.
 * Listening only: the connection that made the call keeps running its tools.
 */
export async function* streamCallEvents(
	client: MimicClient,
	callId: string,
	WebSocketImpl: WebSocketConstructor,
): AsyncGenerator<CallEvent> {
	const ws = new WebSocketImpl(client.streamUrl(callId))
	const queue: Array<CallEvent | Error | null> = []
	let wake: (() => void) | null = null
	let ended = false

	const push = (item: CallEvent | Error | null) => {
		if (ended) return
		if (item === null || item instanceof Error) ended = true
		queue.push(item)
		wake?.()
		wake = null
	}

	ws.addEventListener('open', () => {
		try {
			ws.send(client.streamAuthPayload({ tools: false }))
		} catch (err) {
			push(err instanceof Error ? err : new MimicError(String(err)))
		}
	})
	ws.addEventListener('message', (event) => {
		let msg: ServerMessage
		try {
			msg = JSON.parse(String(event.data)) as ServerMessage
		} catch {
			return
		}
		switch (msg.type) {
			case 'speech':
				push({ type: 'speech', role: msg.role, text: msg.text })
				break
			case 'error':
				push({ type: 'error', message: msg.message })
				break
			case 'done':
				push({ type: 'done', goalAchieved: msg.goalAchieved, goalAchievedReason: msg.goalAchievedReason })
				push(null)
				break
			case 'call_status':
				push({ type: 'status', status: msg.status })
				if (msg.status !== 'pending' && msg.status !== 'in_progress') push(null)
				break
		}
	})
	ws.addEventListener('error', () => push(new MimicError('The call stream dropped')))
	ws.addEventListener('close', () => push(new MimicError('The call stream closed before the call ended')))

	try {
		while (true) {
			if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
			const item = queue.shift()!
			if (item === null) return
			if (item instanceof Error) throw item
			yield item
		}
	} finally {
		ended = true
		ws.close()
	}
}
