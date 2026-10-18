import type { z } from 'zod'

import { MimicCall } from './call.js'
import { MimicClient } from './client.js'
import { MimicError } from './errors.js'
import type { McpConnectionOptions } from './mcp.js'
import { introspectTools } from './tools.js'
import type {
	AgentSpec,
	Call,
	CallOptions,
	CallOptionsBase,
	CallPage,
	CallStatus,
	CompileOptions,
	ExtractSchema,
	ListCallsOptions,
	MimicOptions,
	Prompt,
	ToolInput,
} from './types.js'

/**
 * The Mimic client. Create one with your API key, then make calls.
 *
 * @example
 * ```typescript
 * import { z } from 'zod'
 * import { Mimic, tool } from '@underflowai/mimic'
 *
 * const mimic = new Mimic({ apiKey: 'mk_...' })
 *
 * const checkCalendar = tool({
 *   description: 'Check available calendar slots',
 *   parameters: z.object({ date: z.string().describe('Date to check') }),
 *   run: async ({ date }) => calendar.getSlots(date),
 * })
 *
 * const call = mimic.call({
 *   to: '+15551234567',
 *   goal: 'Confirm the appointment',
 *   tools: { checkCalendar },
 *   extract: z.object({
 *     confirmed: z.boolean().describe('whether the appointment was confirmed'),
 *   }),
 * })
 *
 * call.on('speech', ({ role, text }) => console.log(`[${role}] ${text}`))
 *
 * const result = await call.result
 * if (result.status === 'completed') {
 *   console.log(result.data.confirmed) // boolean | null, typed from `extract`
 * }
 * ```
 */
export class Mimic {
	private readonly client: MimicClient
	private readonly wsOption: MimicOptions['WebSocket']

	/**
	 * Calls that already exist, live or finished.
	 *
	 * @example
	 * ```typescript
	 * const call = await mimic.calls.get(id)          // one call, with transcript, data, recordingUrl
	 * const page = await mimic.calls.list({ limit: 50 }) // newest first; page.nextCursor for more
	 * await mimic.calls.cancel(id)                     // end a call from anywhere
	 * ```
	 */
	readonly calls: {
		/** Fetch a call by id. `recordingUrl` is a fresh one-hour link each time. */
		get: (id: string) => Promise<Call>
		/** Page through your calls, newest first. */
		list: (options?: ListCallsOptions) => Promise<CallPage>
		/** End a call that is pending or in progress. Finished calls are returned as they are. */
		cancel: (id: string) => Promise<{ id: string; status: CallStatus }>
	}

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
		if (!opts.apiKey.startsWith('mk_')) {
			throw new MimicError(
				`Invalid API key format: "${opts.apiKey.slice(0, 8)}...". Expected a key starting with "mk_".`,
			)
		}
		this.client = new MimicClient(opts)
		this.wsOption = typeof options === 'object' ? options.WebSocket : undefined
		this.calls = {
			get: (id) => this.client.getCall(id),
			list: (listOptions) => this.client.listCalls(listOptions),
			cancel: (id) => this.client.cancelCall(id),
		}
	}

	/**
	 * Write the agent's prompt from a goal, once. Nothing is stored: keep the
	 * returned {@link Prompt} (in your repo, your database, wherever), edit it
	 * if you like, and pass it to {@link Mimic.call} as `prompt`. Calls made
	 * with it never recompile, whatever `data`, `extract`, or `recipient` they carry.
	 *
	 * @example
	 * ```typescript
	 * const prompt = await mimic.compile({
	 *   goal: 'Confirm the appointment and note anything the office should know',
	 *   context: 'Greenwood Medical. 24-hour cancellation notice.',
	 *   tools: { checkCalendar },
	 * })
	 * // prompt.systemPrompt, prompt.turnControlBlock, prompt.agentName
	 *
	 * mimic.call({ to: '+15551234567', prompt, data: { appointmentTime: '2pm' } })
	 * ```
	 */
	async compile(options: CompileOptions): Promise<Prompt> {
		return this.client.compilePrompt({
			goal: options.goal,
			context: options.context,
			tools: options.tools ? introspectTools(options.tools) : undefined,
			voice: options.voice,
			aiDisclosure: options.aiDisclosure,
			channel: options.channel,
		})
	}

	/**
	 * Connect to an MCP server and discover its tools. Returns a tools
	 * record that can be passed directly to `.call()`.
	 *
	 * @example
	 * ```typescript
	 * const tools = await mimic.mcp('http://localhost:3000/mcp')
	 * mimic.call({ to: '...', goal: '...', tools })
	 * ```
	 */
	async mcp(url: string, options?: McpConnectionOptions): Promise<Record<string, ToolInput>> {
		const { connectMcp } = await import('./mcp.js')
		return connectMcp(url, options)
	}

	/**
	 * Make a voice call. Returns a {@link MimicCall} that streams events
	 * and resolves with a result typed from your `extract` schema.
	 *
	 * @example
	 * ```typescript
	 * const call = mimic.call({
	 *   to: '+15551234567',
	 *   goal: 'Confirm the appointment', // or `prompt` from mimic.compile()
	 *   tools: { checkCalendar },
	 *   extract: z.object({
	 *     confirmed: z.boolean().describe('whether confirmed'),
	 *   }),
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
	 * if (result.status === 'completed') result.data.confirmed // boolean | null
	 * ```
	 */
	call<S extends ExtractSchema>(
		options: Omit<CallOptionsBase, 'extract'> & { extract: S } & AgentSpec,
	): MimicCall<Extracted<S>>
	call<T extends Record<string, unknown> = Record<string, unknown>>(options: CallOptions): MimicCall<T>
	call(options: CallOptions): MimicCall {
		return new MimicCall({
			client: this.client,
			options,
			WebSocketImpl: this.wsOption,
		})
	}
}

/** The object type an `extract` schema produces, as the result generic expects it. */
type Extracted<S extends ExtractSchema> = { [K in keyof z.infer<S>]: z.infer<S>[K] }

// ── Re-exports ────────────────────────────────────────────────────────

export { MimicCall } from './call.js'
export { ApiError, CallFailedError, CallTimeoutError, MimicError } from './errors.js'
export { connectMcp } from './mcp.js'
export type { McpConnectionOptions } from './mcp.js'
export { introspectTools, tool } from './tools.js'
export { verifyWebhook } from './webhook.js'
export type {
	Call,
	CallChannel,
	CallEvent,
	CallEventMap,
	CallOptions,
	CallOptionsBase,
	CallPage,
	CallResult,
	CallStatus,
	CompileOptions,
	DoneEvent,
	ErrorEvent,
	ExtractedData,
	ExtractSchema,
	ListCallsOptions,
	MimicOptions,
	MimicTool,
	Prompt,
	SpeechEvent,
	ToolCallEvent,
	ToolCallRecord,
	ToolErrorEvent,
	ToolInput,
	ToolResultEvent,
	ToolSchema,
	TranscriptEntry,
	Voice,
	WebhookEvent,
	WebJoin,
} from './types.js'
