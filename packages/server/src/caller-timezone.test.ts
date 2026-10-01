import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { inferCallerTimezone } from './caller-timezone.js'

describe('inferCallerTimezone', () => {
	it('maps a geographic area code to its zone, whatever the number formatting', () => {
		assert.equal(inferCallerTimezone('+12125551234'), 'America/New_York')
		assert.equal(inferCallerTimezone('+1 (415) 555-1234'), 'America/Los_Angeles')
		assert.equal(inferCallerTimezone('13125551234'), 'America/Chicago')
	})

	it('picks the first zone when an area code straddles a boundary', () => {
		assert.equal(inferCallerTimezone('+12085551234'), 'America/Boise')
	})

	it('handles non-NANP numbers', () => {
		assert.equal(inferCallerTimezone('+442079460000'), 'Europe/London')
	})

	it('declines to guess for toll-free, country-wide, or malformed numbers', () => {
		assert.equal(inferCallerTimezone('+18005551234'), null)
		assert.equal(inferCallerTimezone('+1'), null)
		assert.equal(inferCallerTimezone(''), null)
		assert.equal(inferCallerTimezone('not a number'), null)
	})
})
