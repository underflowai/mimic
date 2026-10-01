import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildWriteGateSources, checkWriteArgs, strictValueKind, type WriteGateSource } from './write-gate.js'

const caller = (text: string): WriteGateSource => ({ kind: 'caller', label: 'caller', text })
const readResult = (toolName: string, text: string): WriteGateSource => ({
	kind: 'read_result',
	label: `read_result:${toolName}`,
	text,
})
const known = (text: string): WriteGateSource => ({ kind: 'known_values', label: 'known_values', text })

describe('strictValueKind', () => {
	it('recognizes contact details and identifiers', () => {
		assert.equal(strictValueKind('sam@example.com'), 'email')
		assert.equal(strictValueKind('+1 (415) 555-1234'), 'phone')
		assert.equal(strictValueKind('4155551234'), 'phone')
		assert.equal(strictValueKind('ABC123'), 'code')
		assert.equal(strictValueKind('P-4471-X'), 'code')
		assert.equal(strictValueKind('447192'), 'code')
	})

	it('leaves dates, times, short numbers, names, and prose to the advisory path', () => {
		for (const value of [
			'2026-10-07',
			'2026-10-07T15:00:00',
			'3:00 PM',
			'15:00',
			'10/07/2026',
			'12345',
			'Dr. Patel',
			'Tuesday 3 PM',
			'two people',
		]) {
			assert.equal(strictValueKind(value), null, value)
		}
	})
})

describe('checkWriteArgs', () => {
	it('finds a phone number the caller spoke as digits, national format against a stored +1 number', () => {
		const result = checkWriteArgs('sendText', { to: '+1 415 555 1234' }, [
			caller('Sure, text me at four one five, five five five, one two three four.'),
		])
		assert.deepEqual(result.blocked, [])
		assert.equal(result.evidence[0]?.arg, 'to')
		assert.equal(result.evidence[0]?.source, 'caller')
		assert.match(result.evidence[0]!.quote, /four one five/)
	})

	it('finds an email spelled out in speech', () => {
		const result = checkWriteArgs('sendEmail', { to: 'sam.jones@example.com' }, [
			caller('It is sam dot jones at example dot com.'),
		])
		assert.deepEqual(result.blocked, [])
		assert.equal(result.evidence.length, 1)
	})

	it('finds a code in a lookup result or spelled letter by letter', () => {
		assert.deepEqual(
			checkWriteArgs('cancel', { confirmation: 'ABC123' }, [readResult('lookupBooking', '{"confirmation":"ABC123"}')])
				.blocked,
			[],
		)
		assert.deepEqual(checkWriteArgs('cancel', { confirmation: 'ABC123' }, [caller('A B C one two three')]).blocked, [])
	})

	it('blocks a contact detail nobody said and nothing returned, and says what to do', () => {
		const result = checkWriteArgs('sendText', { to: '+14155551234', message: 'See you Tuesday' }, [
			caller('Yes, send me a text.'),
			readResult('lookupPatient', '{"name":"Jordan"}'),
		])
		assert.deepEqual(result.blocked, ['to'])
		assert.deepEqual(result.unverified, ['message'])
		assert.match(result.reason!, /sendText must wait: to \(phone number "\+14155551234"\)/)
		assert.match(result.reason!, /Read the value back/)
	})

	it('accepts integrator-supplied values as a source', () => {
		const result = checkWriteArgs('sendText', { to: '+14155551234' }, [
			caller('Yes, send me a text.'),
			known('<data>\npatientPhone: (415) 555-1234\n</data>'),
		])
		assert.deepEqual(result.blocked, [])
		assert.equal(result.evidence[0]?.source, 'known_values')
	})

	it('records dates, names, and free text as evidence or unverified without blocking', () => {
		const result = checkWriteArgs(
			'book',
			{ when: 'Tuesday 3 PM', provider: 'Dr. Patel', note: 'Patient prefers a window seat and a late check-in.' },
			[
				readResult('checkCalendar', 'Open: Tuesday 3 PM with Dr. Patel; Thursday 9 AM with Dr. Lee'),
				caller('Tuesday at three works.'),
			],
		)
		assert.deepEqual(result.blocked, [])
		assert.deepEqual(result.unverified, ['note'])
		assert.deepEqual(
			result.evidence.map((span) => [span.arg, span.source]),
			[
				['when', 'read_result:checkCalendar'],
				['provider', 'read_result:checkCalendar'],
			],
		)
		assert.equal(result.reason, null)
	})

	it('checks nested and array arguments by path', () => {
		const result = checkWriteArgs(
			'createOrder',
			{ customer: { phone: '415 555 1234' }, items: [{ sku: 'SKU-88812' }] },
			[caller('four one five five five five one two three four')],
		)
		assert.deepEqual(result.blocked, ['items[0].sku'])
		assert.equal(result.evidence[0]?.arg, 'customer.phone')
	})

	it('ignores booleans, nulls, and values too short to mean anything', () => {
		const result = checkWriteArgs('book', { count: 2, flexible: true, note: null, code: 'AB' }, [])
		assert.deepEqual(result, { blocked: [], unverified: [], evidence: [], reason: null })
	})
})

describe('buildWriteGateSources', () => {
	it('uses caller turns, read results, the live transcript, and known values; never agent turns', () => {
		const sources = buildWriteGateSources({
			readResults: [{ toolName: 'lookup', result: 'found' }],
			turns: [
				{ role: 'agent', content: 'Your number is 415 555 1234, right?' },
				{ role: 'user', content: 'Yes.' },
			],
			callerTranscript: 'Go ahead.',
			knownValues: ['office: Bright Smiles', ''],
		})
		assert.deepEqual(
			sources.map((s) => [s.kind, s.text]),
			[
				['read_result', 'found'],
				['caller', 'Yes.'],
				['caller', 'Go ahead.'],
				['known_values', 'office: Bright Smiles'],
			],
		)
	})
})
