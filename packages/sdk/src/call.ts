import { MimicClient } from './client.js'
import { CallFailedError, CallTimeoutError, MimicError } from './errors.js'
import { executeTool, introspectTools } from './tools.js'
import type {
	ApiCall,
	CallEvent,
	CallOptions,
	CallResult,
	ServerMessage,
	ToolFunction,
	WebSocketConstructor,
} from './types.js'

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 2_000
const DEFAULT_TOOL_TIMEOUT_MS = 30_000
const MAX_BUFFERED_EVENTS = 500

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function toCallResult(call: ApiCall): CallResult {
	return {
		id: call.id,
		status: call.status === 'failed' ? 'failed' : 'completed',
		goalAchieved: call.goalAchieved ?? false,
		goalAchievedReason: call.goalAchievedReason ?? '',
		data: call.result ?? {},
		transcript: call.transcript ?? [],
		duration: call.duration,
	}
}

interface MimicCallInit {
	client: MimicClient
	options: CallOptions
	/** Pass `null` to force polling mode (no WebSocket). */
	WebSocketImpl?: WebSocketConstructor | null
}

/**
 * A live voice call. Implements `AsyncIterable<CallEvent>` for real-time
 * streaming, and exposes `.result` as a `Promise<CallResult>` for
 * fire-and-forget usage.
 *
 * @example
 * ```typescript
 * // Stream events
 * for await (const event of call) {
 *   console.log(event)
 * }
 *
 * // Or just await the result
 * const result = await call.result
 * ```
 */
export class MimicCall implements AsyncIterable<CallEvent> {
	/** Resolves when the call completes with the final result. */
	readonly result: Promise<CallResult>

	private callId: string | null = null
	private readonly client: MimicClient
	private readonly options: CallOptions
	private readonly tools: Record<string, ToolFunction>
	private readonly WebSocketImpl: WebSocketConstructor | undefined
	private readonly eventBuffer: CallEvent[] = []
	private readonly waiters: Array<(event: CallEvent | null) => void> = []
	private done = false
	private settled = false
	private resultResolve!: (result: CallResult) => void
	private resultReject!: (error: Error) => void
	private streamTimeout: ReturnType<typeof setTimeout> | null = null
	private activeWs: WebSocket | null = null
	private cancelled = false

	constructor(init: MimicCallInit) {
		this.client = init.client
		this.options = init.options
		this.tools = init.options.tools ?? {}
		this.WebSocketImpl = init.WebSocketImpl === null ? undefined : (init.WebSocketImpl ?? globalThis.WebSocket)

		this.result = new Promise<CallResult>((resolve, reject) => {
			this.resultResolve = resolve
			this.resultReject = reject
		})

		this.result.catch(() => {})

		void this.start()
	}

	/**
	 * Cancel the call. Closes the WebSocket, stops polling, and rejects
	 * `.result` with a `MimicError`.
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
				extract: this.options.extract,
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
					this.settle('resolve', toCallResult(fullCall))
				} catch {
					this.settle('resolve', {
						id: this.callId!,
						status: 'completed',
						goalAchieved: msg.goalAchieved,
						goalAchievedReason: msg.goalAchievedReason,
						data: {},
						transcript: [],
						duration: null,
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

	// ── Tool execution with timeout ────────────────────────────────────

	private async executeToolWithTimeout(name: string, args: Record<string, unknown>): Promise<string> {
		const timeoutMs = this.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS

		return Promise.race([
			executeTool(this.tools, name, args),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${timeoutMs}ms`)), timeoutMs),
			),
		])
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
					const result = toCallResult(call)
					this.pushEvent({
						type: 'done',
						goalAchieved: result.goalAchieved,
						goalAchievedReason: result.goalAchievedReason,
					})
					this.complete()
					this.settle('resolve', result)
					return
				}

				if (call.status === 'failed') {
					const err = new CallFailedError(call.errorMessage ?? 'Call failed', callId, call)
					this.pushEvent({ type: 'error', message: err.message })
					this.complete()
					this.settle('reject', err)
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

	// ── Result settlement (guarded against double-resolve) ─────────────

	private settle(type: 'resolve', result: CallResult): void
	private settle(type: 'reject', error: Error): void
	private settle(type: 'resolve' | 'reject', value: CallResult | Error): void {
		if (this.settled) return
		this.settled = true
		if (type === 'resolve') this.resultResolve(value as CallResult)
		else this.resultReject(value as Error)
	}

	// ── Event buffering for async iteration ────────────────────────────

	private pushEvent(event: CallEvent) {
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
