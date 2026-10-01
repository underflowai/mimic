import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { getDb } from './index.js'

/** Journal tag for the schema that production was pushed to, before any migration ran. */
const BASELINE_TAG = '0000_safe_jamie_braddock'

/**
 * Session lock so the API and the worker can both migrate at boot without
 * applying the same statements twice. Two int4 keys select the (int, int) overload.
 */
const LOCK_KEY1 = 8811
const LOCK_KEY2 = 200001

export type BaselineAction = 'migrate' | 'baseline' | 'refuse'

/**
 * Production was created with drizzle-kit push, so 0000's CREATE statements
 * would fail if replayed. Record that migration when its objects are already
 * there. A database with neither object is empty and should run 0000. Anything
 * in between is an unknown schema: stop rather than guess.
 */
export function baselineAction(state: {
	appliedMigrations: number
	apiKeys: boolean
	idempotencyIndex: boolean
}): BaselineAction {
	if (state.appliedMigrations > 0) return 'migrate'
	if (!state.apiKeys && !state.idempotencyIndex) return 'migrate'
	if (state.apiKeys && state.idempotencyIndex) return 'baseline'
	return 'refuse'
}

function migrationsFolder(): string {
	const besideModule = fileURLToPath(new URL('./migrations', import.meta.url))
	if (fs.existsSync(path.join(besideModule, 'meta', '_journal.json'))) return besideModule
	const fromSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations')
	if (fs.existsSync(path.join(fromSource, 'meta', '_journal.json'))) return fromSource
	throw new Error(`[db] migrations folder not found (tried ${besideModule} and ${fromSource})`)
}

function baselineMigration(folder: string): { hash: string; createdAt: number } {
	const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8')) as {
		entries?: { tag?: string; when?: number }[]
	}
	const entry = journal.entries?.find((item) => item.tag === BASELINE_TAG)
	if (!entry || typeof entry.when !== 'number') {
		throw new Error(`[db] baseline migration ${BASELINE_TAG} is missing from the journal`)
	}
	const query = fs.readFileSync(path.join(folder, `${BASELINE_TAG}.sql`)).toString()
	const hash = crypto.createHash('sha256').update(query).digest('hex')
	return { hash, createdAt: entry.when }
}

async function baselinePushedSchema(sql: postgres.Sql, folder: string) {
	const [rels] = await sql<{ api_keys: boolean; idempotency_index: boolean }[]>`
		select
			to_regclass('public.api_keys') is not null as api_keys,
			to_regclass('public.api_calls_api_key_id_idempotency_key_unique') is not null as idempotency_index
	`
	const [journal] = await sql<{ present: boolean }[]>`
		select to_regclass('drizzle.__drizzle_migrations') is not null as present
	`
	let appliedMigrations = 0
	if (journal?.present === true) {
		const [count] = await sql<{ n: number | string }[]>`
			select count(*)::int as n from drizzle.__drizzle_migrations
		`
		appliedMigrations = Number(count?.n ?? 0)
	}

	const action = baselineAction({
		appliedMigrations,
		apiKeys: rels?.api_keys === true,
		idempotencyIndex: rels?.idempotency_index === true,
	})
	if (action === 'migrate') return
	if (action === 'refuse') {
		throw new Error(
			`[db] existing tables do not match migration ${BASELINE_TAG} (api_keys=${String(rels?.api_keys)}, idempotency_index=${String(rels?.idempotency_index)}) and drizzle.__drizzle_migrations is empty. Refusing to start.`,
		)
	}

	const { hash, createdAt } = baselineMigration(folder)
	await sql`create schema if not exists drizzle`
	await sql`
		create table if not exists drizzle.__drizzle_migrations (
			id serial primary key,
			hash text not null,
			created_at bigint
		)
	`
	await sql`
		insert into drizzle.__drizzle_migrations (hash, created_at)
		values (${hash}, ${createdAt})
	`
	console.log(`[db] recorded ${BASELINE_TAG} as applied`)
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
		await baselinePushedSchema(lock, folder)
		// Drizzle applies a migration only when its journal timestamp is greater
		// than the latest created_at. Baselining 0000 makes that row equal, so
		// the CREATE statements are skipped and later migrations still run.
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
