import pino from 'pino'

const isTestEnv = process.env.NODE_TEST_CONTEXT !== undefined || process.env.NODE_ENV === 'test'

export const log = isTestEnv
	? pino({ level: 'warn' })
	: pino({
			level: process.env.LOG_LEVEL ?? 'info',
			transport: {
				targets: [
					{
						target: 'pino-pretty',
						level: 'info',
						options: {
							colorize: true,
							translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
							ignore: 'pid,hostname',
							messageFormat: '{module} | {msg}',
						},
					},
				],
			},
		})

export function createLogger(module: string) {
	return log.child({ module })
}
