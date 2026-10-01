/**
 * Process-wide pino logger.
 *
 * Output is JSON on stdout, which is what log shippers want. Pretty-printing
 * is a development convenience: on by default outside production, opt in/out
 * with LOG_PRETTY, and only ever used when `pino-pretty` is installed (it is
 * an optional peer dependency).
 */

import { createRequire } from 'node:module'

import pino from 'pino'

const env = process.env
const isTestEnv = env.NODE_TEST_CONTEXT !== undefined || env.NODE_ENV === 'test'
const level = env.LOG_LEVEL ?? (isTestEnv ? 'warn' : 'info')

function prettyRequested() {
	if (env.LOG_PRETTY !== undefined) return env.LOG_PRETTY === '1' || env.LOG_PRETTY === 'true'
	return env.NODE_ENV !== 'production' && !isTestEnv
}

function prettyAvailable() {
	try {
		createRequire(import.meta.url).resolve('pino-pretty')
		return true
	} catch {
		return false
	}
}

export const log =
	prettyRequested() && prettyAvailable()
		? pino({
				level,
				transport: {
					target: 'pino-pretty',
					options: {
						colorize: true,
						translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
						ignore: 'pid,hostname',
						messageFormat: '{module} | {msg}',
					},
				},
			})
		: pino({ level })

export function createLogger(module: string) {
	return log.child({ module })
}
