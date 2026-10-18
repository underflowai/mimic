/**
 * Mint an API key for one app and print it once; only its hash is stored.
 * The name is how you tell keys apart later (`SELECT name, key_prefix FROM
 * api_keys`) and what `revoke-key.ts` leaves behind, so name the holder.
 *
 * Usage: tsx src/scripts/create-key.ts <name> [DATABASE_URL]
 */

import postgres from 'postgres'

import { generateApiKey } from '../auth.js'

const name = process.argv[2]?.trim()
const url = process.argv[3] || process.env.DATABASE_URL
if (!name || !url) {
	console.error('Usage: tsx src/scripts/create-key.ts <name> [DATABASE_URL]')
	process.exit(1)
}

const sql = postgres(url)
const key = generateApiKey()

await sql`INSERT INTO api_keys (key_hash, key_prefix, name) VALUES (${key.keyHash}, ${key.keyPrefix}, ${name})`
console.log(key.rawKey)

await sql.end()
