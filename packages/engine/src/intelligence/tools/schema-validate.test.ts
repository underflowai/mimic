import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { validateToolArgs } from './schema-validate.js'

const schema = {
	type: 'object',
	properties: {
		date: { type: 'string', description: 'ISO date' },
		partySize: { type: 'number', description: 'How many people' },
		confirmed: { type: 'boolean' },
		slots: { type: 'array' },
	},
	required: ['date', 'partySize'],
}

describe('validateToolArgs', () => {
	it('passes through tools without a JSON Schema untouched', () => {
		const result = validateToolArgs({ date: 'the date to check' }, { date: 'Thursday', extra: 1 })
		assert.equal(result.ok, true)
		assert.deepEqual(result.args, { date: 'Thursday', extra: 1 })
	})

	it('coerces watcher string args to schema types', () => {
		const result = validateToolArgs(schema, { date: '2026-07-14', partySize: '4', confirmed: 'yes' })
		assert.equal(result.ok, true)
		assert.deepEqual(result.args, { date: '2026-07-14', partySize: 4, confirmed: true })
	})

	it('rejects missing required parameters', () => {
		const result = validateToolArgs(schema, { date: '2026-07-14' })
		assert.equal(result.ok, false)
		assert.match(result.errors.join(' '), /partySize/)
	})

	it('rejects uncoercible values', () => {
		const result = validateToolArgs(schema, { date: '2026-07-14', partySize: 'a few' })
		assert.equal(result.ok, false)
		assert.match(result.errors.join(' '), /partySize: expected number/)
	})

	it('null args do not satisfy required parameters', () => {
		const result = validateToolArgs(schema, { date: null, partySize: '2' })
		assert.equal(result.ok, false)
		assert.match(result.errors.join(' '), /date/)
	})

	it('enforces enums when present', () => {
		const withEnum = {
			type: 'object',
			properties: { urgency: { type: 'string', enum: ['low', 'high'] } },
			required: [],
		}
		assert.equal(validateToolArgs(withEnum, { urgency: 'high' }).ok, true)
		const bad = validateToolArgs(withEnum, { urgency: 'medium' })
		assert.equal(bad.ok, false)
		assert.match(bad.errors.join(' '), /urgency/)
	})

	it('flags unknown parameters when additionalProperties is false', () => {
		const strict = { ...schema, additionalProperties: false }
		const result = validateToolArgs(strict, { date: 'x', partySize: '2', bogus: '1' })
		assert.equal(result.ok, false)
		assert.match(result.errors.join(' '), /unknown parameter "bogus"/)
	})

	it('parses JSON strings for array and object parameters', () => {
		const result = validateToolArgs(schema, { date: 'x', partySize: '2', slots: '["9am","10am"]' })
		assert.equal(result.ok, true)
		assert.deepEqual(result.args.slots, ['9am', '10am'])
	})
})
