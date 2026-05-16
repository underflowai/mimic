import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
	cartesiaChunkSchema,
	cartesiaDoneSchema,
	cartesiaErrorSchema,
	cartesiaFlushDoneSchema,
	cartesiaResponseSchema,
	fluxEventSchema,
	parseWebSocketJsonWithSchema,
} from './transport-schemas.js'

describe('parseWebSocketJsonWithSchema', () => {
	it('parses valid Buffer payloads', () => {
		const payload = { type: 'chunk', data: 'Zm9v', done: false, status_code: 206, step_time: 10, context_id: 'ctx-1' }
		const raw = Buffer.from(JSON.stringify(payload))
		const result = parseWebSocketJsonWithSchema(raw, cartesiaChunkSchema)
		assert.equal(result.ok, true)
		if (!result.ok) return
		assert.equal(result.data.data, 'Zm9v')
		assert.equal(result.data.context_id, 'ctx-1')
	})

	it('parses valid ArrayBuffer payloads', () => {
		const payload = { type: 'chunk', data: 'Zm9v', done: false, status_code: 206, step_time: 5, context_id: 'ctx-2' }
		const bytes = Buffer.from(JSON.stringify(payload))
		const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
		const result = parseWebSocketJsonWithSchema(arrayBuffer, cartesiaChunkSchema)
		assert.equal(result.ok, true)
		if (!result.ok) return
		assert.equal(result.data.data, 'Zm9v')
	})

	it('parses Cartesia done response', () => {
		const payload = { type: 'done', done: true, status_code: 200, context_id: 'ctx-1' }
		const result = parseWebSocketJsonWithSchema(Buffer.from(JSON.stringify(payload)), cartesiaDoneSchema)
		assert.equal(result.ok, true)
		if (!result.ok) return
		assert.equal(result.data.done, true)
	})

	it('parses Cartesia error response', () => {
		const payload = { type: 'error', message: 'rate limit exceeded', status_code: 429, context_id: 'ctx-1' }
		const result = parseWebSocketJsonWithSchema(Buffer.from(JSON.stringify(payload)), cartesiaErrorSchema)
		assert.equal(result.ok, true)
		if (!result.ok) return
		assert.equal(result.data.message, 'rate limit exceeded')
	})

	it('parses Cartesia flush_done response', () => {
		const payload = {
			type: 'flush_done',
			done: false,
			flush_done: true,
			flush_id: 1,
			status_code: 206,
			context_id: 'ctx-1',
		}
		const result = parseWebSocketJsonWithSchema(Buffer.from(JSON.stringify(payload)), cartesiaFlushDoneSchema)
		assert.equal(result.ok, true)
		if (!result.ok) return
		assert.equal(result.data.flush_id, 1)
	})

	it('parses union of Cartesia response types', () => {
		const chunk = { type: 'chunk', data: 'Zm9v', done: false, status_code: 206, step_time: 10, context_id: 'ctx-1' }
		const done = { type: 'done', done: true, status_code: 200, context_id: 'ctx-1' }
		const error = { type: 'error', message: 'fail', status_code: 500 }

		for (const payload of [chunk, done, error]) {
			const result = parseWebSocketJsonWithSchema(Buffer.from(JSON.stringify(payload)), cartesiaResponseSchema)
			assert.equal(result.ok, true)
		}
	})

	it('returns invalid_json for malformed JSON', () => {
		const result = parseWebSocketJsonWithSchema(Buffer.from('{bad-json'), fluxEventSchema)
		assert.equal(result.ok, false)
		if (result.ok) return
		assert.equal(result.reason, 'invalid_json')
	})

	it('returns invalid_shape when required fields are missing', () => {
		const result = parseWebSocketJsonWithSchema(Buffer.from(JSON.stringify({ event: 'Update' })), fluxEventSchema)
		assert.equal(result.ok, false)
		if (result.ok) return
		assert.equal(result.reason, 'invalid_shape')
	})

	it('accepts known Deepgram event payload shape', () => {
		const result = parseWebSocketJsonWithSchema(
			Buffer.from(
				JSON.stringify({ type: 'TurnInfo', event: 'Update', transcript: 'hello', end_of_turn_confidence: 0.7 }),
			),
			fluxEventSchema,
		)
		assert.equal(result.ok, true)
		if (!result.ok) return
		assert.equal(result.data.type, 'TurnInfo')
		assert.equal(result.data.event, 'Update')
	})
})
