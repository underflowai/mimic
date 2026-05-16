import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema.js'

function getDatabaseUrl(): string {
	const url = process.env.DATABASE_URL
	if (!url) throw new Error('DATABASE_URL environment variable is required')
	return url
}

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getDb() {
	if (!_db) {
		const client = postgres(getDatabaseUrl(), {
			max: 10,
			idle_timeout: 0,
			connect_timeout: 10,
		})
		_db = drizzle(client, { schema })
	}
	return _db
}

export { schema }
