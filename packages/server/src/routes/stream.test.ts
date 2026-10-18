import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { handleStreamUpgrade } from './stream.js'

// No DATABASE_URL is set here, so any path that reaches getDb() throws. These
// tests cover the branches that must settle before a database is touched.

function fakeSocket() {
	const sent: string[] = []
	let closed = false
	return {
		ws: {
			send: (data: string) => {
				sent.push(data)
			},
			close: () => {
				closed = true
			},
		},
		sent,
		isClosed: () => closed,
	}
}

async function openWithHeader(callId: string) {
	const socket = fakeSocket()
	const handlers = handleStreamUpgrade(callId, 'mk_live_not_a_real_key')
	await handlers.onOpen(undefined, socket.ws)
	// onOpen schedules the bind without awaiting it; let it settle.
	await new Promise((resolve) => setImmediate(resolve))
	handlers.onClose(undefined, socket.ws)
	return socket
}

describe('handleStreamUpgrade', () => {
	it('rejects a call id that is not a UUID before authenticating', async () => {
		const socket = await openWithHeader('tatiana-verification-no-call')
		assert.deepEqual(
			socket.sent.map((raw) => JSON.parse(raw) as unknown),
			[{ type: 'error', message: 'Call not found or unauthorized' }],
		)
		assert.equal(socket.isClosed(), true)
	})

	it('rejects a missing call id', async () => {
		const socket = await openWithHeader('')
		assert.deepEqual(
			socket.sent.map((raw) => JSON.parse(raw) as unknown),
			[{ type: 'error', message: 'Missing call id' }],
		)
		assert.equal(socket.isClosed(), true)
	})

	it('closes the socket instead of leaking a rejection when binding throws', async () => {
		// A well-formed id gets past the guards and into authenticateToken, which
		// throws here because there is no database. That must end as a closed
		// socket, not an unhandled rejection.
		const socket = await openWithHeader('00000000-0000-4000-8000-000000000000')
		assert.deepEqual(
			socket.sent.map((raw) => JSON.parse(raw) as unknown),
			[{ type: 'error', message: 'Could not open the call stream' }],
		)
		assert.equal(socket.isClosed(), true)
	})
})
