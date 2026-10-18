import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { RoomEvent } from '@livekit/rtc-node'

import { waitForCaller, type CallerWaitRoom } from './caller-wait.js'

function fakeRoom() {
	const emitter = new EventEmitter()
	return { room: emitter as unknown as CallerWaitRoom, emitter }
}

function listenerCount(emitter: EventEmitter) {
	return emitter.listenerCount(RoomEvent.ParticipantConnected) + emitter.listenerCount(RoomEvent.Disconnected)
}

describe('waitForCaller', () => {
	it('resolves when a participant joins and removes its listeners', async () => {
		const { room, emitter } = fakeRoom()
		const wait = waitForCaller(room, 10_000)
		emitter.emit(RoomEvent.ParticipantConnected, {})
		await wait
		assert.equal(listenerCount(emitter), 0)
	})

	it('rejects when the room disconnects first', async () => {
		const { room, emitter } = fakeRoom()
		const wait = waitForCaller(room)
		emitter.emit(RoomEvent.Disconnected)
		await assert.rejects(wait, /disconnected before caller joined/)
		assert.equal(listenerCount(emitter), 0)
	})

	it('rejects with a caller-facing message when nobody joins in time', async () => {
		const { room, emitter } = fakeRoom()
		await assert.rejects(waitForCaller(room, 20), /No one joined the call within 0 seconds/)
		assert.equal(listenerCount(emitter), 0)
	})

	it('waits indefinitely when no timeout is given', async () => {
		const { room, emitter } = fakeRoom()
		let settled = false
		const wait = waitForCaller(room).finally(() => {
			settled = true
		})
		await new Promise((resolve) => setTimeout(resolve, 30))
		assert.equal(settled, false)
		emitter.emit(RoomEvent.ParticipantConnected, {})
		await wait
	})
})
