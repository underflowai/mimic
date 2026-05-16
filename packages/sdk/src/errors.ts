/**
 * Base error class for all Mimic SDK errors.
 *
 * @example
 * ```typescript
 * try {
 *   await call.result
 * } catch (err) {
 *   if (err instanceof MimicError) console.error(err.message)
 * }
 * ```
 */
export class MimicError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'MimicError'
	}
}

function deriveErrorCode(status: number): string {
	if (status === 400) return 'invalid_request'
	if (status === 401) return 'authentication_failed'
	if (status === 404) return 'not_found'
	if (status === 409) return 'conflict'
	if (status === 429) return 'rate_limited'
	return 'server_error'
}

function extractField(body: unknown, field: string): string | null {
	if (body && typeof body === 'object' && field in body) {
		const value = (body as Record<string, unknown>)[field]
		return typeof value === 'string' ? value : null
	}
	return null
}

/**
 * Thrown when the Mimic API returns a non-2xx response.
 *
 * @example
 * ```typescript
 * try {
 *   await call.result
 * } catch (err) {
 *   if (err instanceof ApiError) {
 *     console.error(err.code, err.status, err.requestId)
 *   }
 * }
 * ```
 */
export class ApiError extends MimicError {
	readonly code: string
	readonly requestId: string | null

	constructor(
		message: string,
		readonly status: number,
		readonly body: unknown,
	) {
		super(message)
		this.name = 'ApiError'
		this.code = extractField(body, 'code') ?? deriveErrorCode(status)
		this.requestId = extractField(body, 'requestId')
	}
}

/**
 * Thrown when a call exceeds the configured `timeoutMs`.
 *
 * @example
 * ```typescript
 * try {
 *   await call.result
 * } catch (err) {
 *   if (err instanceof CallTimeoutError) {
 *     console.error(`Call ${err.callId} timed out`)
 *   }
 * }
 * ```
 */
export class CallTimeoutError extends MimicError {
	constructor(
		message: string,
		readonly callId?: string,
	) {
		super(message)
		this.name = 'CallTimeoutError'
	}
}

/**
 * Thrown when a call reaches a terminal failed state.
 *
 * @example
 * ```typescript
 * try {
 *   await call.result
 * } catch (err) {
 *   if (err instanceof CallFailedError) {
 *     console.error(`Call ${err.callId} failed`)
 *   }
 * }
 * ```
 */
export class CallFailedError extends MimicError {
	constructor(
		message: string,
		readonly callId: string,
		readonly body: unknown,
	) {
		super(message)
		this.name = 'CallFailedError'
	}
}
