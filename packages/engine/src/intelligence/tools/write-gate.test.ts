import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildWriteGateSources, checkWriteArgs } from './write-gate.js'

const readResults = [
	{
		toolName: 'checkCalendar',
		result: 'Available slots: Tuesday 3:00 PM, Wednesday 10:00 AM, Thursday 2:30 PM',
	},
]

const callerTurns = [
	{ role: 'user' as const, content: 'Yeah Tuesday works, my email is dan@acme.com' },
	{ role: 'agent' as const, content: 'Tuesday at three, dan@acme.com — got it.' },
]

describe('write gate', () => {
	it('allows args grounded in READ results and caller speech, with evidence spans', () => {
		const sources = buildWriteGateSources(readResults, callerTurns)
		const gate = checkWriteArgs('bookAppointment', { slot: 'Tuesday 3:00 PM', email: 'dan@acme.com' }, sources)

		assert.equal(gate.allowed, true)
		assert.equal(gate.evidence.length, 2)
		const slotEvidence = gate.evidence.find((e) => e.arg === 'slot')
		assert.equal(slotEvidence?.source, 'read_result:checkCalendar')
		assert.match(slotEvidence?.quote ?? '', /Tuesday 3:00 PM/)
		const emailEvidence = gate.evidence.find((e) => e.arg === 'email')
		assert.equal(emailEvidence?.source, 'caller_turn')
	})

	it('blocks args that appear nowhere in the call', () => {
		const sources = buildWriteGateSources(readResults, callerTurns)
		const gate = checkWriteArgs('bookAppointment', { slot: 'Friday 5:00 PM' }, sources)

		assert.equal(gate.allowed, false)
		assert.deepEqual(gate.unverified, ['slot'])
		assert.match(gate.reason ?? '', /Friday 5:00 PM/)
		assert.match(gate.reason ?? '', /read it back/)
	})

	it('matches watcher-normalized values against spoken number words', () => {
		const sources = buildWriteGateSources([], [{ role: 'user', content: 'Tuesday at three pm works for me' }])
		const gate = checkWriteArgs('bookAppointment', { slot: 'Tuesday 3:00 PM' }, sources)
		assert.equal(gate.allowed, true)
	})

	it('matches long digit strings across formatting differences', () => {
		const sources = buildWriteGateSources([], [{ role: 'user', content: 'four one five two eight three nine one one eight' }])
		const gate = checkWriteArgs('lookupCustomer', { phone: '415-283-9118' }, sources)
		assert.equal(gate.allowed, true)
	})

	it('skips booleans and very short values', () => {
		const sources = buildWriteGateSources([], [])
		const gate = checkWriteArgs('updateRecord', { confirmed: true, initials: 'dk' }, sources)
		assert.equal(gate.allowed, true)
		assert.equal(gate.evidence.length, 0)
	})

	it('includes the latest uncommitted caller transcript as evidence', () => {
		const sources = buildWriteGateSources([], [], 'book it for Wednesday 10 AM please')
		const gate = checkWriteArgs('bookAppointment', { slot: 'Wednesday 10:00 AM' }, sources)
		assert.equal(gate.allowed, true)
		assert.equal(gate.evidence[0].source, 'caller_turn')
	})
})
