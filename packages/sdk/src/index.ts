import { MimicCall } from './call.js'
import { MimicClient } from './client.js'
import { MimicError } from './errors.js'
import type { CallOptions, MimicOptions } from './types.js'

/**
 * The Mimic client. Create one with your API key, then make calls.
 *
 * @example
 * ```typescript
 * import { z } from 'zod'
 * import { Mimic, tool } from '@mimic/sdk'
 *
 * const mimic = new Mimic({ apiKey: 'mk_...' })
 *
 * const checkCalendar = tool({
 *   description: 'Check available calendar slots',
 *   parameters: z.object({ date: z.string().describe('Date to check') }),
 *   run: async ({ date }) => calendar.getSlots(date),
 * })
 *
 * const call = mimic.call<{ confirmed: boolean }>({
 *   to: '+15551234567',
 *   goal: 'Confirm the appointment',
 *   tools: { checkCalendar },
 *   extract: { confirmed: 'whether the appointment was confirmed' },
 * })
 *
 * call.on('speech', ({ role, text }) => console.log(`[${role}] ${text}`))
 *
 * const result = await call.result
 * if (result.status === 'completed') {
 *   console.log(result.data.confirmed) // boolean
 * }
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
	 *
	 * @example
	 * ```typescript
	 * const mimic = new Mimic('mk_...')
	 * // or
	 * const mimic = new Mimic({ apiKey: 'mk_...', baseUrl: 'http://localhost:3000' })
	 * ```
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
	 * Make a voice call. Returns a {@link MimicCall} that streams events
	 * and resolves with a typed result.
	 *
	 * @typeParam T - Shape of the extracted data. Must match the `extract` keys.
	 *
	 * @example
	 * ```typescript
	 * const call = mimic.call<{ confirmed: boolean }>({
	 *   to: '+15551234567',
	 *   goal: 'Confirm the appointment',
	 *   tools: { checkCalendar },
	 *   extract: { confirmed: 'whether confirmed' },
	 * })
	 *
	 * // Option A: stream events
	 * for await (const event of call) { ... }
	 *
	 * // Option B: typed event handlers
	 * call.on('speech', ({ text }) => console.log(text))
	 *
	 * // Option C: just get the result
	 * const result = await call.result
	 * ```
	 */
	call<T extends Record<string, unknown> = Record<string, never>>(options: CallOptions<T>): MimicCall<T> {
		return new MimicCall<T>({
			client: this.client,
			options,
			WebSocketImpl: this.wsOption,
		})
	}
}

// ── Re-exports ────────────────────────────────────────────────────────

export { MimicCall } from './call.js'
export { ApiError, CallFailedError, CallTimeoutError, MimicError } from './errors.js'
export { introspectTools, parseParameterNames, tool } from './tools.js'
export type {
	CallEvent,
	CallEventMap,
	CallOptions,
	CallResult,
	DoneEvent,
	ErrorEvent,
	MimicOptions,
	MimicTool,
	SpeechEvent,
	ToolCallEvent,
	ToolErrorEvent,
	ToolInput,
	ToolResultEvent,
	ToolSchema,
	TranscriptEntry,
	Voice,
} from './types.js'
