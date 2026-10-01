/**
 * Revoke an API key by its raw value.
 *
 * Usage: tsx scripts/revoke-key.ts <rawKey> [DATABASE_URL]
 */

import { createHash } from 'node:crypto'
import postgres from 'postgres'

const rawKey = process.argv[2]
const url = process.argv[3] || process.env.DATABASE_URL
if (!rawKey || !url) {
	console.error('Usage: tsx scripts/revoke-key.ts <rawKey> [DATABASE_URL]')
	process.exit(1)
}

const keyHash = createHash('sha256').update(rawKey).digest('hex')
const sql = postgres(url)

const rows = await sql`UPDATE api_keys SET status = 'revoked' WHERE key_hash = ${keyHash} RETURNING id, key_prefix, name, status`
if (rows.length === 0) {
	console.error('No key found with that value.')
} else {
	for (const row of rows) console.log(`revoked ${row.key_prefix}… (${row.name}, id=${row.id})`)
}

await sql.end()
