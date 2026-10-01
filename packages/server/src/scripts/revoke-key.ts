/**
 * Revoke an API key. Pass the raw key (mk_live_…) or, when the raw key is
 * gone, its prefix as shown by `SELECT key_prefix FROM api_keys`.
 *
 * Usage: tsx src/scripts/revoke-key.ts <rawKey | --prefix <keyPrefix>> [DATABASE_URL]
 */

import { createHash } from 'node:crypto'
import postgres from 'postgres'

const args = process.argv.slice(2)
const byPrefix = args[0] === '--prefix'
const target = byPrefix ? args[1] : args[0]
const url = (byPrefix ? args[2] : args[1]) || process.env.DATABASE_URL
if (!target || !url) {
	console.error('Usage: tsx src/scripts/revoke-key.ts <rawKey | --prefix <keyPrefix>> [DATABASE_URL]')
	process.exit(1)
}

const sql = postgres(url)
const rows = byPrefix
	? await sql`UPDATE api_keys SET status = 'revoked' WHERE key_prefix = ${target} AND status = 'active' RETURNING id, key_prefix, name`
	: await sql`UPDATE api_keys SET status = 'revoked' WHERE key_hash = ${createHash('sha256').update(target).digest('hex')} AND status = 'active' RETURNING id, key_prefix, name`

if (rows.length === 0) {
	console.error('No active key matched.')
	process.exitCode = 1
} else {
	for (const row of rows) console.log(`revoked ${row.key_prefix}… (${row.name}, id=${row.id})`)
}

await sql.end()
