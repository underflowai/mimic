import { MimicCall } from './call.js'
import { MimicClient } from './client.js'
import { MimicError } from './errors.js'
import type { CallOptions, MimicOptions, ToolFunction } from './types.js'

/**
 * The Mimic client. Create one with your API key, then make calls.
 *
 * @example
 * ```typescript
 * import { Mimic } from '@mimic/sdk'
 *
 * const mimic = new Mimic('mk_...')
 *
 * // Three arguments: who, what, with
 * const call = mimic.call('+15551234567', 'Book an appointment', {
 *   checkCalendar,
 *   bookMeeting,
 * })
 *
 * // Stream events in real-time
 * for await (const event of call) {
 *   console.log(event)
 * }
 *
 * // Or just await the result
 * const result = await call.result
 * ```
 */
export class Mimic {
	private readonly client: MimicClient
	private readonly wsOption: MimicOptions['WebSocket']

	/**
	 * Create a Mimic client.
	 *
	 * @param options - API key string or full options object.
	 * @throws {MimicError} If the API key is empty or malformed.
	 */
	constructor(options: string | MimicOptions) {
		const opts = typeof options === 'string' ? { apiKey: options } : options
		if (!opts.apiKey || typeof opts.apiKey !== 'string') {
			throw new MimicError('API key is required. Pass a string starting with "mk_".')
		}
		if (!opts.apiKey.startsWith('mk_') && !opts.apiKey.startsWith('sk_')) {
			throw new MimicError(`Invalid API key format: "${opts.apiKey.slice(0, 8)}...". Expected a key starting with "mk_".`)
		}
		this.client = new MimicClient(opts)
		this.wsOption = typeof options === 'object' ? options.WebSocket : undefined
	}

	/**
	 * Make a voice call.
	 *
	 * Returns a {@link MimicCall} that is both an `AsyncIterable<CallEvent>`
	 * (for streaming) and has a `.result` promise (for fire-and-forget).
	 *
	 * @example
	 * ```typescript
	 * // Positional: who, what, with
	 * const call = mimic.call('+15551234567', 'Book an appointment', {
	 *   checkCalendar,
	 *   bookMeeting,
	 * })
	 * ```
	 *
	 * @example
	 * ```typescript
	 * // Options object for full control
	 * const call = mimic.call({
	 *   to: '+15551234567',
	 *   goal: 'Book an appointment',
	 *   tools: { checkCalendar, bookMeeting },
	 *   voice: 'female',
	 *   context: { patientName: 'Jane Doe' },
	 *   extract: { confirmed: 'whether confirmed', notes: 'any notes' },
	 * })
	 * ```
	 */
	call(options: CallOptions): MimicCall
	call(to: string, goal: string, tools?: Record<string, ToolFunction>): MimicCall
	call(
		toOrOptions: string | CallOptions,
		goal?: string,
		tools?: Record<string, ToolFunction>,
	): MimicCall {
		const options: CallOptions =
			typeof toOrOptions === 'string'
				? { to: toOrOptions, goal: goal!, tools }
				: toOrOptions

		return new MimicCall({
			client: this.client,
			options,
			WebSocketImpl: this.wsOption,
		})
	}
}

// ── Re-exports ────────────────────────────────────────────────────────

export { MimicCall } from './call.js'
export { ApiError, CallFailedError, CallTimeoutError, ConnectionError, MimicError } from './errors.js'
export { introspectTools, parseParameterNames } from './tools.js'
export type {
	CallEvent,
	CallOptions,
	CallResult,
	DoneEvent,
	ErrorEvent,
	MimicOptions,
	SpeechEvent,
	ToolCallEvent,
	ToolErrorEvent,
	ToolFunction,
	ToolResultEvent,
	ToolSchema,
	TranscriptEntry,
	Voice,
} from './types.js'
