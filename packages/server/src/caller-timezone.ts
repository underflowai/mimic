import phoneToTimezone from 'phone-to-timezone'

/**
 * Guess a caller's IANA timezone from their phone number's area code.
 *
 * Google's libphonenumber prefix map (which `phone-to-timezone` bundles) gives
 * one zone for most geographic area codes, two where a code straddles a
 * boundary (Idaho's 208: Boise and Los Angeles), and the whole country for
 * toll-free or non-geographic prefixes. We guess when there are at most two
 * candidates and stay silent otherwise. The guess is only ever a starting
 * point: the engine labels it unconfirmed and the agent checks it with the
 * caller the first time a specific time matters.
 */
export function inferCallerTimezone(phone: string): string | null {
	const digits = phone.replace(/\D/g, '')
	if (digits.length < 8) return null
	let candidates: string[]
	try {
		candidates = phoneToTimezone(digits)
	} catch {
		return null
	}
	if (candidates.length === 0 || candidates.length > 2) return null
	const guess = candidates[0]!
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: guess })
	} catch {
		return null
	}
	return guess
}
