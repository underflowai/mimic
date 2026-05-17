/**
 * API key generation and verification.
 *
 * Keys are stored as SHA-256 hashes — the raw key is only returned once
 * at creation time.
 *
 * @example
 * ```typescript
 * const { rawKey, keyHash, keyPrefix } = generateApiKey()
 * // rawKey: 'mk_live_abc123...' — give to the user
 * // keyHash: 'sha256 hex' — store in your database
 * // keyPrefix: 'mk_live_abc123' — for display/identification
 *
 * const isValid = verifyApiKey(rawKey, storedKeyHash)
 * ```
 */

import { createHash, randomBytes } from 'node:crypto'
import { timingSafeEqual } from 'node:crypto'

const KEY_PREFIX = 'mk_live_'
const KEY_PREFIX_LENGTH = 16

function hashKey(key: string) {
	return createHash('sha256').update(key).digest('hex')
}

export interface GeneratedKey {
	rawKey: string
	keyHash: string
	keyPrefix: string
}

/**
 * Generate a new API key. Returns the raw key (show once), the hash
 * (store in DB), and a display prefix for identification.
 */
export function generateApiKey(): GeneratedKey {
	const rawKey = `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`
	return {
		rawKey,
		keyHash: hashKey(rawKey),
		keyPrefix: keyPrefixFor(rawKey),
	}
}

export function keyPrefixFor(rawKey: string) {
	return rawKey.slice(0, KEY_PREFIX_LENGTH)
}

/**
 * Verify a raw API key against a stored hash.
 */
export function verifyApiKey(rawKey: string, storedHash: string): boolean {
	const computed = hashKey(rawKey)
	if (computed.length !== storedHash.length) return false
	return timingSafeEqual(Buffer.from(computed), Buffer.from(storedHash))
}
