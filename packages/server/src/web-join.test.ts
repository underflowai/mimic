import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TokenVerifier } from 'livekit-server-sdk'

import { createWebJoin, WEB_JOIN_TTL_SECONDS } from './web-join.js'

const livekit = {
	url: 'wss://example.livekit.cloud',
	apiKey: 'APIkey',
	apiSecret: 'secret-that-is-long-enough-to-sign',
}

describe('createWebJoin', () => {
	it('issues a token scoped to the call room, publish and subscribe only', async () => {
		const join = await createWebJoin({ callId: 'call-1', name: 'Tatiana', livekit })
		assert.equal(join.url, livekit.url)

		const claims = await new TokenVerifier(livekit.apiKey, livekit.apiSecret).verify(join.token)
		assert.equal(claims.sub, 'caller-call-1')
		assert.equal(claims.name, 'Tatiana')
		assert.equal(claims.video?.roomJoin, true)
		assert.equal(claims.video?.room, 'mimic-call-call-1')
		assert.equal(claims.video?.canPublish, true)
		assert.equal(claims.video?.canSubscribe, true)
		assert.ok(!claims.video?.roomAdmin && !claims.video?.roomCreate && !claims.video?.roomList)
		assert.ok(typeof claims.exp === 'number' && typeof claims.nbf === 'number')
		assert.ok(claims.exp - claims.nbf <= WEB_JOIN_TTL_SECONDS + 5)
	})
})
