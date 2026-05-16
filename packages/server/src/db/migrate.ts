import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { getDb } from './index.js'

export async function runMigrations() {
	const db = getDb()
	await migrate(db, { migrationsFolder: new URL('./migrations', import.meta.url).pathname })
	console.log('[db] migrations complete')
}
