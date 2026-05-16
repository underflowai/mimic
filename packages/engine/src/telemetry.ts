type MetricData = { unit?: string; attributes?: Record<string, string | number | boolean> }

let _sentry: typeof import('@sentry/node') | null = null

try {
	_sentry = await import('@sentry/node')
} catch {
	// @sentry/node is an optional peer dependency
}

export const metrics = {
	count(name: string, value?: number, data?: MetricData) {
		_sentry?.metrics.count(name, value, data)
	},
	gauge(name: string, value: number, data?: MetricData) {
		_sentry?.metrics.gauge(name, value, data)
	},
	distribution(name: string, value: number, data?: MetricData) {
		_sentry?.metrics.distribution(name, value, data)
	},
}
