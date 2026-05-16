import { MimicClient } from './client.js'
import { CallFailedError, CallTimeoutError, MimicError } from './errors.js'
import { executeTool, introspectTools } from './tools.js'
import type {
	ApiCall,
	CallEvent,
	CallEventMap,
	CallOptions,
	CallResult,
	ServerMessage,
	ToolInput,
	WebSocketConstructor,
} from './types.js'

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 2_000
const DEFAULT_TOOL_TIMEOUT_MS = 30_000
const MAX_BUFFERED_EVENTS = 500

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function toCallResult<T extends Record<string, unknown>>(call: ApiCall): CallResult<T> {
	if (call.status === 'failed') {
		return { status: 'failed', id: call.id, error: call.errorMessage ?? 'Call failed' }
	}
	return {
		status: 'completed',
		id: call.id,
		goalAchieved: call.goalAchieved ?? false,
		goalAchievedReason: call.goalAchievedReason ?? '',
		data: (call.result ?? {}) as T,
		transcript: (call.transcript ?? []).map((e) => ({
			role: e.role as 'agent' | 'caller',
			content: e.content,
		})),
		duration: call.duration ?? 0,
	}
}

function levenshtein(a: string, b: string): number {
	const m = a.length
	const n = b.length
	const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[])
	for (let i = 0; i <= m; i++) dp[i]![0] = i
	for (let j = 0; j <= n; j++) dp[0]![j] = j
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i]![j] = a[i - 1] === b[j - 1]
				? dp[i - 1]![j - 1]!
				: 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!)
		}
	}
	return dp[m]![n]!
}

function suggestToolName(name: string, available: string[]): string | null {
	if (available.length === 0) return null
	let best = available[0]!
	let bestDist = levenshtein(name.toLowerCase(), best.toLowerCase())
	for (let i = 1; i < available.length; i++) {
		const dist = levenshtein(name.toLowerCase(), available[i]!.toLowerCase())
		if (dist < bestDist) {
			bestDist = dist
			best = available[i]!
		}
	}
	return bestDist <= 3 ? best : null
}

/** @internal */
export interface MimicCallInit<T extends Record<string, unknown>> {
	client: MimicClient
	options: CallOptions<T>
	WebSocketImpl?: WebSocketConstructor | null
}

/**
 * A live voice call. Stream events in real-time via `for await` or
 * `.on()`, and get the final result from `.result`.
 *
 * @typeParam T - Shape of the extracted data. Inferred from `CallOptions<T>`.
 *
 * @example
 * ```typescript
 * // Stream with for-await
 * for await (const event of call) {
 *   if (event.type === 'speech') console.log(event.text)
 * }
 *
 * // Or use typed event handlers
 * call.on('speech', ({ role, text }) => console.log(`[${role}] ${text}`))
 * call.on('done', ({ goalAchieved }) => console.log(goalAchieved))
 *
 * // Or just await the result
 * const result = await call.result
 * if (result.status === 'completed') console.log(result.data)
 * ```
 */
export class MimicCall<T extends Record<string, unknown> = Record<string, unknown>>
	implements AsyncIterable<CallEvent>
{
	/** Resolves when the call completes with the final typed result. */
	readonly result: Promise<CallResult<T>>

	private callId: string | null = null
	private readonly client: MimicClient
	private readonly options: CallOptions<T>
	private readonly tools: Record<string, ToolInput>
	private readonly WebSocketImpl: WebSocketConstructor | undefined
	private readonly eventBuffer: CallEvent[] = []
	private readonly waiters: Array<(event: CallEvent | null) => void> = []
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private readonly listeners: Record<string, Array<(event: any) => void>> = {}
	private done = false
	private settled = false
	private resultResolve!: (result: CallResult<T>) => void
	private resultReject!: (error: Error) => void
	private streamTimeout: ReturnType<typeof setTimeout> | null = null
	private activeWs: WebSocket | null = null
	private cancelled = false

	constructor(init: MimicCallInit<T>) {
		this.client = init.client
		this.options = init.options
		this.tools = init.options.tools ?? {}
		this.WebSocketImpl = init.WebSocketImpl === null ? undefined : (init.WebSocketImpl ?? globalThis.WebSocket)

		this.result = new Promise<CallResult<T>>((resolve, reject) => {
			this.resultResolve = resolve
			this.resultReject = reject
		})
		this.result.catch(() => {})

		void this.start()
	}

	/**
	 * Register a typed event handler. The callback type is narrowed
	 * based on the event name.
	 *
	 * @example
	 * ```typescript
	 * call.on('speech', ({ role, text }) => console.log(`[${role}] ${text}`))
	 * call.on('tool_call', ({ name, args }) => console.log(name, args))
	 * call.on('done', ({ goalAchieved }) => console.log(goalAchieved))
	 * ```
	 */
	on<K extends keyof CallEventMap>(type: K, handler: (event: CallEventMap[K]) => void): this {
		;(this.listeners[type] ??= []).push(handler)
		return this
	}

	/**
	 * Cancel the call. Closes the connection and rejects `.result`.
	 *
	 * @example
	 * ```typescript
	 * const call = mimic.call({ to: '+15551234567', goal: 'Say hello' })
	 * setTimeout(() => call.cancel(), 60_000)
	 * ```
	 */
	cancel() {
		if (this.done) return
		this.cancelled = true
		this.activeWs?.close()
		this.pushEvent({ type: 'error', message: 'Call cancelled' })
		this.complete()
		this.settle('reject', new MimicError('Call cancelled'))
	}

	async *[Symbol.asyncIterator](): AsyncIterator<CallEvent> {
		while (true) {
			const event = await this.nextEvent()
			if (event === null) return
			yield event
		}
	}

	// ── Lifecycle ──────────────────────────────────────────────────────

	private async start() {
		try {
			const toolSchemas = introspectTools(this.tools)

			const { call } = await this.client.createCall({
				goal: this.options.goal,
				to: this.options.to,
				voice: this.options.voice,
				context: this.options.context,
				tools: toolSchemas,
				extract: this.options.extract as Record<string, string> | undefined,
				idempotencyKey: this.options.idempotencyKey,
			})

			this.callId = call.id

			if (this.cancelled) return

			if (this.WebSocketImpl) {
				this.connectStream(call.id)
			} else {
				await this.pollUntilDone(call.id)
			}
		} catch (err) {
			if (this.cancelled) return
			const error = err instanceof Error ? err : new MimicError(String(err))
			this.pushEvent({ type: 'error', message: error.message })
			this.complete()
			this.settle('reject', error)
		}
	}

	// ── Streaming via WebSocket ────────────────────────────────────────

	private connectStream(callId: string) {
		const url = this.client.streamUrl(callId)
		const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
		const ws = new this.WebSocketImpl!(url)
		this.activeWs = ws
		let fallbackTriggered = false

		this.streamTimeout = setTimeout(() => {
			ws.close()
			const err = new CallTimeoutError(`Call timed out after ${timeoutMs}ms`, callId)
			this.pushEvent({ type: 'error', message: err.message })
			this.complete()
			this.settle('reject', err)
		}, timeoutMs)

		const tryPollFallback = () => {
			if (this.streamTimeout) clearTimeout(this.streamTimeout)
			if (!this.done && !fallbackTriggered && !this.cancelled) {
				fallbackTriggered = true
				void this.pollUntilDone(callId)
			}
		}

		ws.addEventListener('message', (event) => {
			void this.handleServerMessage(ws, String(event.data))
		})

		ws.addEventListener('close', tryPollFallback)
		ws.addEventListener('error', tryPollFallback)
	}

	private async handleServerMessage(ws: WebSocket, raw: string) {
		let msg: ServerMessage
		try {
			msg = JSON.parse(raw) as ServerMessage
		} catch {
			return
		}

		switch (msg.type) {
			case 'speech':
				this.pushEvent({ type: 'speech', role: msg.role, text: msg.text })
				break

			case 'tool_call': {
				this.pushEvent({ type: 'tool_call', name: msg.toolName, args: msg.toolArgs })

				try {
					const result = await this.executeToolWithTimeout(msg.toolName, msg.toolArgs)
					this.pushEvent({ type: 'tool_result', name: msg.toolName, result })
					ws.send(JSON.stringify({ type: 'tool_result', callbackId: msg.callbackId, result }))
				} catch (err) {
					const error = err instanceof Error ? err.message : String(err)
					this.pushEvent({ type: 'tool_error', name: msg.toolName, error })
					ws.send(JSON.stringify({ type: 'tool_error', callbackId: msg.callbackId, error }))
				}
				break
			}

			case 'done': {
				this.pushEvent({
					type: 'done',
					goalAchieved: msg.goalAchieved,
					goalAchievedReason: msg.goalAchievedReason,
				})
				this.complete()

				try {
					const fullCall = await this.client.getCall(this.callId!)
					this.settle('resolve', toCallResult<T>(fullCall))
				} catch {
					this.settle('resolve', {
						status: 'completed',
						id: this.callId!,
						goalAchieved: msg.goalAchieved,
						goalAchievedReason: msg.goalAchievedReason,
						data: {} as T,
						transcript: [],
						duration: 0,
					})
				}
				break
			}

			case 'error':
				this.pushEvent({ type: 'error', message: msg.message })
				break

			case 'call_status':
				if (msg.status === 'failed') {
					this.pushEvent({ type: 'error', message: 'Call failed' })
					this.complete()
					this.settle('reject', new CallFailedError('Call failed', this.callId!, msg))
				}
				break
		}
	}

	// ── Tool execution ─────────────────────────────────────────────────

	private async executeToolWithTimeout(name: string, args: Record<string, unknown>): Promise<string> {
		const available = Object.keys(this.tools)
		if (!this.tools[name]) {
			const suggestion = suggestToolName(name, available)
			const availStr = available.length > 0 ? ` Available tools: ${available.join(', ')}.` : ''
			const didYouMean = suggestion ? ` Did you mean "${suggestion}"?` : ''
			throw new Error(`Tool "${name}" is not registered.${availStr}${didYouMean}`)
		}

		const timeoutMs = this.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
		let timer: ReturnType<typeof setTimeout> | null = null

		try {
			return await Promise.race([
				executeTool(this.tools, name, args),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${timeoutMs}ms`)), timeoutMs)
				}),
			])
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	// ── Polling fallback ───────────────────────────────────────────────

	private async pollUntilDone(callId: string) {
		const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
		const pollIntervalMs = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
		const started = Date.now()

		while (Date.now() - started < timeoutMs) {
			if (this.cancelled) return

			try {
				const call = await this.client.getCall(callId)

				if (call.status === 'completed') {
					const result = toCallResult<T>(call)
					if (result.status === 'completed') {
						this.pushEvent({
							type: 'done',
							goalAchieved: result.goalAchieved,
							goalAchievedReason: result.goalAchievedReason,
						})
					}
					this.complete()
					this.settle('resolve', result)
					return
				}

				if (call.status === 'failed') {
					const result = toCallResult<T>(call)
					const errMsg = result.status === 'failed' ? result.error : 'Call failed'
					this.pushEvent({ type: 'error', message: errMsg })
					this.complete()
					this.settle('reject', new CallFailedError(errMsg, callId, call))
					return
				}
			} catch {
				// Transient error — keep polling
			}

			await sleep(pollIntervalMs)
		}

		const err = new CallTimeoutError(`Call timed out after ${timeoutMs}ms`, callId)
		this.pushEvent({ type: 'error', message: err.message })
		this.complete()
		this.settle('reject', err)
	}

	// ── Settlement ─────────────────────────────────────────────────────

	private settle(type: 'resolve', result: CallResult<T>): void
	private settle(type: 'reject', error: Error): void
	private settle(type: 'resolve' | 'reject', value: CallResult<T> | Error): void {
		if (this.settled) return
		this.settled = true
		if (type === 'resolve') this.resultResolve(value as CallResult<T>)
		else this.resultReject(value as Error)
	}

	// ── Event buffering + dispatch ─────────────────────────────────────

	private pushEvent(event: CallEvent) {
		const handlers = this.listeners[event.type]
		if (handlers) {
			for (const handler of handlers) handler(event)
		}

		// Buffer for async iteration
		if (this.waiters.length > 0) {
			const waiter = this.waiters.shift()!
			waiter(event)
		} else {
			if (this.eventBuffer.length >= MAX_BUFFERED_EVENTS) {
				this.eventBuffer.shift()
			}
			this.eventBuffer.push(event)
		}
	}

	private complete() {
		this.done = true
		if (this.streamTimeout) {
			clearTimeout(this.streamTimeout)
			this.streamTimeout = null
		}
		this.activeWs = null
		for (const waiter of this.waiters) {
			waiter(null)
		}
		this.waiters.length = 0
	}

	private nextEvent(): Promise<CallEvent | null> {
		if (this.eventBuffer.length > 0) {
			return Promise.resolve(this.eventBuffer.shift()!)
		}
		if (this.done) return Promise.resolve(null)
		return new Promise((resolve) => {
			this.waiters.push(resolve)
		})
	}
}
