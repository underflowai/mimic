export interface TimeoutOptions {
	signal?: AbortSignal
	message?: string
	onTimeout?: () => void
}

function toError(err: unknown) {
	return err instanceof Error ? err : new Error(String(err))
}

export function isAbortLikeError(err: unknown) {
	if (!err) return false
	if (err instanceof DOMException) return err.name === 'AbortError'
	if (err instanceof Error && err.name === 'AbortError') return true

	const e = err as { name?: unknown; code?: unknown; message?: unknown }
	if (e.name === 'AbortError') return true
	if (e.code === 'ABORT_ERR' || e.code === 'ERR_ABORTED') return true
	if (typeof e.message === 'string' && /\b(aborted|cancelled|canceled)\b/i.test(e.message)) return true
	return false
}

export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, opts: TimeoutOptions = {}) {
	if (opts.signal?.aborted) throw new DOMException('operation aborted', 'AbortError')
	if (timeoutMs <= 0) return operation

	return new Promise<T>((resolve, reject) => {
		let settled = false
		const finish = (handler: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			opts.signal?.removeEventListener('abort', onAbort)
			handler()
		}
		const onAbort = () => {
			finish(() => reject(new DOMException('operation aborted', 'AbortError')))
		}
		const timeout = setTimeout(() => {
			finish(() => {
				opts.onTimeout?.()
				reject(new Error(opts.message ?? `operation timed out after ${timeoutMs}ms`))
			})
		}, timeoutMs)
		opts.signal?.addEventListener('abort', onAbort, { once: true })

		operation.then(
			(value) => finish(() => resolve(value)),
			(err) => finish(() => reject(toError(err))),
		)
	})
}

export function safeInvoke<T>(callback: (() => T) | null | undefined, onError: (err: Error) => void) {
	if (!callback) return undefined
	try {
		return callback()
	} catch (err) {
		const error = toError(err)
		onError(error)
		return undefined
	}
}
