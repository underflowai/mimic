import pino from 'pino'

export const logger = pino({
	level: process.env.LOG_LEVEL ?? 'info',
	...(process.env.NODE_ENV !== 'production'
		? { transport: { target: 'pino-pretty', options: { colorize: true } } }
		: {}),
})

export function childLogger(context: Record<string, unknown>) {
	return logger.child(context)
}
