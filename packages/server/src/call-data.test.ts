import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { describeDataShape, renderDataBlock, renderDataSchema } from './call-data.js'

describe('describeDataShape', () => {
	it('is empty for no data', () => {
		assert.equal(describeDataShape(undefined), null)
		assert.equal(describeDataShape({}), null)
	})

	it('records field names, types, and whether a value was supplied — never the value', () => {
		const shape = describeDataShape({ b: 'x', a: 2, ok: true, none: null })
		assert.deepEqual(shape, {
			a: { kind: 'value', type: 'number' },
			b: { kind: 'value', type: 'text' },
			none: { kind: 'missing' },
			ok: { kind: 'value', type: 'boolean' },
		})
		assert.deepEqual(describeDataShape({ b: 'y', a: 7, ok: false, none: undefined }), shape)
	})

	it('describes lists by the union of their item fields, not their length', () => {
		const two = describeDataShape({ visits: [{ date: 'a' }, { date: 'b', reason: 'cleaning' }] })
		const three = describeDataShape({ visits: [{ date: 'c', reason: 'x' }, { date: 'd' }, { date: 'e' }] })
		assert.deepEqual(two, three)
		assert.deepEqual(two, {
			visits: {
				kind: 'list',
				items: {
					kind: 'object',
					fields: { date: { kind: 'value', type: 'text' }, reason: { kind: 'value', type: 'text' } },
				},
			},
		})
		assert.deepEqual(describeDataShape({ tags: ['a', 'b'] }), {
			tags: { kind: 'list', items: { kind: 'value', type: 'text' } },
		})
		assert.deepEqual(describeDataShape({ tags: [] }), { tags: { kind: 'list', items: null } })
	})

	it('keeps constrained-field options and metadata, masking the value', () => {
		const shape = describeDataShape({
			preference: { value: 'morning', validOptions: ['morning', 'afternoon'], condition: 'Only when rescheduling' },
		})
		assert.deepEqual(shape, {
			preference: {
				kind: 'constrained',
				provided: true,
				validOptions: ['morning', 'afternoon'],
				metadata: { condition: 'Only when rescheduling' },
			},
		})
	})
})

describe('renderDataSchema / renderDataBlock', () => {
	const data = {
		appointmentTime: 'Tuesday 3 PM',
		notes: null,
		insurance: { carrier: 'Acme', memberId: '123' },
		preference: { value: null, validOptions: ['morning', 'afternoon'] },
	}

	it('renders the schema for the compiler without values', () => {
		const schema = renderDataSchema(data)
		assert.equal(
			schema,
			[
				'appointmentTime: provided (text)',
				'insurance:',
				'  carrier: provided (text)',
				'  memberId: provided (text)',
				'notes: missing',
				'preference: missing (valid options: morning, afternoon)',
			].join('\n'),
		)
		assert.equal(renderDataSchema(undefined), 'No structured data provided.')
	})

	it('renders the values for the live agent', () => {
		const block = renderDataBlock(data)
		assert.match(block, /^<data>\n/)
		assert.match(block, /appointmentTime: Tuesday 3 PM/)
		assert.match(block, /notes: MISSING/)
		assert.match(block, /insurance:\n {2}carrier: Acme\n {2}memberId: 123/)
		assert.match(block, /preference: MISSING \(valid options: morning, afternoon\)/)
		assert.match(block, /\n<\/data>$/)
		assert.equal(renderDataBlock(null), '')
		assert.equal(renderDataBlock({}), '')
	})
})
