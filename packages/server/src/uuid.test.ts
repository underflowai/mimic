import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'

import { isUuid } from './uuid.js'

describe('isUuid', () => {
	it('accepts gen_random_uuid() output in either case', () => {
		const id = randomUUID()
		assert.equal(isUuid(id), true)
		assert.equal(isUuid(id.toUpperCase()), true)
	})

	it('rejects anything Postgres would fail to cast or that we never issue', () => {
		for (const value of [
			'',
			'tatiana-verification-no-call',
			'00000000-0000-4000-8000-00000000000', // one hex digit short
			'00000000-0000-4000-8000-0000000000000', // one hex digit long
			'{00000000-0000-4000-8000-000000000000}', // braces: valid for Postgres, never issued
			'000000000000400080000000000000000', // no hyphens
			"' or 1=1 --",
		]) {
			assert.equal(isUuid(value), false, value)
		}
	})
})
