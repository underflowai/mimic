import { generateApiKey } from '../auth.js'
import postgres from 'postgres'

const url = process.argv[2] || process.env.DATABASE_URL
if (!url) {
	console.error('Usage: tsx scripts/create-key.ts <DATABASE_URL>')
	process.exit(1)
}

const sql = postgres(url)
const key = generateApiKey()

await sql`INSERT INTO api_keys (key_hash, key_prefix, name) VALUES (${key.keyHash}, ${key.keyPrefix}, 'default')`
console.log(key.rawKey)

await sql.end()
