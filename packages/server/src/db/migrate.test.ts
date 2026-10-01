import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { baselineAction } from './migrate.js'

describe('baselineAction', () => {
	it('runs the journal on an empty database', () => {
		assert.equal(baselineAction({ appliedMigrations: 0, apiKeys: false, idempotencyIndex: false }), 'migrate')
	})

	it('records 0000 when the pushed schema is already present', () => {
		assert.equal(baselineAction({ appliedMigrations: 0, apiKeys: true, idempotencyIndex: true }), 'baseline')
	})

	it('leaves an existing journal to the migrator', () => {
		assert.equal(baselineAction({ appliedMigrations: 1, apiKeys: true, idempotencyIndex: true }), 'migrate')
	})

	it('refuses a partial schema with no journal', () => {
		assert.equal(baselineAction({ appliedMigrations: 0, apiKeys: true, idempotencyIndex: false }), 'refuse')
		assert.equal(baselineAction({ appliedMigrations: 0, apiKeys: false, idempotencyIndex: true }), 'refuse')
	})
})
