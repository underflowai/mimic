/**
 * Build on prepare when sources are present (e.g. git dependency install).
 * Skip when only package.json was copied (Docker deps layer) — the image
 * build step compiles after the full source tree is available.
 * Restore dev dependencies when a consumer's production-only deploy omits
 * the compiler from the temporary Git checkout.
 */
import { accessSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const engineDir = fileURLToPath(new URL('..', import.meta.url))
const workspaceDir = fileURLToPath(new URL('../../..', import.meta.url))

try {
	accessSync(new URL('../tsconfig.lib.json', import.meta.url))
} catch {
	process.exit(0)
}

const hasCompiler = spawnSync('pnpm', ['exec', 'tsc', '--version'], {
	cwd: engineDir,
	stdio: 'ignore',
	shell: true,
})

if (hasCompiler.status !== 0) {
	const install = spawnSync('pnpm', ['install', '--prod=false', '--ignore-scripts', '--frozen-lockfile'], {
		cwd: workspaceDir,
		stdio: 'inherit',
		shell: true,
	})
	if (install.status !== 0) process.exit(install.status ?? 1)
}

const result = spawnSync('pnpm', ['run', 'build'], { cwd: engineDir, stdio: 'inherit', shell: true })
process.exit(result.status ?? 1)
