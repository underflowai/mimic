/**
 * Build on prepare when sources are present (e.g. git dependency install).
 * Skip when only package.json was copied (Docker deps layer) — the image
 * build step compiles after the full source tree is available.
 */
import { accessSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

try {
	accessSync(new URL('../tsconfig.lib.json', import.meta.url))
} catch {
	process.exit(0)
}

const result = spawnSync('pnpm', ['run', 'build'], { stdio: 'inherit', shell: true })
process.exit(result.status ?? 1)
