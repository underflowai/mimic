import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { getDb } from './index.js'

/**
 * Session lock so the API and the worker can both migrate at boot without
 * applying the same statements twice. Two int4 keys select the (int, int) overload.
 */
const LOCK_KEY1 = 8811
const LOCK_KEY2 = 200001

function migrationsFolder(): string {
	const besideModule = fileURLToPath(new URL('./migrations', import.meta.url))
	if (fs.existsSync(path.join(besideModule, 'meta', '_journal.json'))) return besideModule
	const fromSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations')
	if (fs.existsSync(path.join(fromSource, 'meta', '_journal.json'))) return fromSource
	throw new Error(`[db] migrations folder not found (tried ${besideModule} and ${fromSource})`)
}

export async function runMigrations() {
	const folder = migrationsFolder()
	const url = process.env.DATABASE_URL
	if (!url) throw new Error('DATABASE_URL environment variable is required')

	const lock = postgres(url, { max: 1, connect_timeout: 10 })
	let locked = false
	try {
		await lock`select pg_advisory_lock(${LOCK_KEY1}::int, ${LOCK_KEY2}::int)`
		locked = true
		await migrate(getDb(), { migrationsFolder: folder })
		console.log('[db] migrations complete')
	} finally {
		if (locked) {
			await lock`select pg_advisory_unlock(${LOCK_KEY1}::int, ${LOCK_KEY2}::int)`.catch((err) => {
				console.error('[db] failed to release migration lock', err)
			})
		}
		await lock.end({ timeout: 5 })
	}
}

function isDirectRun(): boolean {
	const entry = process.argv[1]
	if (!entry) return false
	return path.resolve(entry) === fileURLToPath(import.meta.url)
}

if (isDirectRun()) {
	runMigrations()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error('[db] migration failed', err)
			process.exit(1)
		})
}
