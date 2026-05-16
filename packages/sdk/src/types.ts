import type { ZodType } from 'zod'

// ── Client options ────────────────────────────────────────────────────

/**
 * Options for creating a {@link Mimic} client.
 *
 * @example
 * ```typescript
 * const mimic = new Mimic({ apiKey: 'mk_...' })
 * ```
 */
export interface MimicOptions {
	/** Your Mimic API key. Starts with `mk_`. */
	apiKey: string
	/** Override the API base URL. Defaults to `https://api.mimic.dev`. */
	baseUrl?: string
	/** Custom `fetch` implementation. Defaults to the global `fetch`. */
	fetch?: typeof fetch
	/** Custom `WebSocket` constructor, or `null` to disable streaming (forces polling). */
	WebSocket?: WebSocketConstructor | null
}

/** @internal */
export type WebSocketConstructor = {
	new (url: string | URL, protocols?: string | string[]): WebSocket
	readonly CONNECTING: number
	readonly OPEN: number
	readonly CLOSING: number
	readonly CLOSED: number
}

// ── Voice ─────────────────────────────────────────────────────────────

/** Voice persona for the agent. */
export type Voice = 'female' | 'male'

// ── Tool types ────────────────────────────────────────────────────────

/**
 * A structured tool definition created by {@link tool}. The Zod schema
 * is the single source of truth for parameter names, types, and
 * descriptions. The `run` handler's input is inferred from the schema.
 *
 * @example
 * ```typescript
 * import { z } from 'zod'
 * import { tool } from '@mimic/sdk'
 *
 * const checkCalendar = tool({
 *   description: 'Check available calendar slots',
 *   parameters: z.object({
 *     date: z.string().describe('The date to check'),
 *   }),
 *   run: async ({ date }) => calendar.getSlots(date),
 * })
 * ```
 */
export interface MimicTool {
	/** @internal */
	__mimicTool: true
	description: string
	schema: ZodType
	run: (input: unknown) => Promise<string> | string
}

/**
 * A tool the agent can use during a call. Prefer {@link MimicTool}
 * (created via `tool()`) for type safety. Plain functions are supported
 * as a convenience fallback.
 *
 * @example
 * ```typescript
 * // Recommended: structured tool with Zod schema
 * const checkCalendar = tool({
 *   description: 'Check available calendar slots',
 *   parameters: z.object({ date: z.string().describe('Date to check') }),
 *   run: async ({ date }) => calendar.getSlots(date),
 * })
 *
 * // Fallback: plain function (name and params introspected at runtime)
 * async function getHours() { return '9am-5pm' }
 * ```
 */
export type ToolInput = MimicTool | (Function & { description?: string; params?: Record<string, string> })

/** @internal Wire format for tool definitions sent to the API. */
export interface ToolSchema {
	name: string
	description: string
	parameters: Record<string, string>
}

// ── Call options ───────────────────────────────────────────────────────

/**
 * Options for making a voice call via {@link Mimic.call}.
 *
 * @typeParam T - Shape of the structured data to extract from the call.
 *   Keys must match the `extract` descriptions. Defaults to `{}`.
 *
 * @example
 * ```typescript
 * const call = mimic.call<{ confirmed: boolean }>({
 *   to: '+15551234567',
 *   goal: 'Confirm the appointment',
 *   extract: { confirmed: 'whether the appointment was confirmed' },
 *   tools: { checkCalendar },
 * })
 * ```
 */
export interface CallOptions<T extends Record<string, unknown> = Record<string, never>> {
	/** Phone number to call (E.164 format, e.g. `'+15551234567'`). */
	to: string
	/** What the agent should accomplish on the call. */
	goal: string
	/** Tools the agent can use. Keys are tool names. */
	tools?: Record<string, ToolInput>
	/** Voice persona. Defaults to `'female'`. */
	voice?: Voice
	/** Office ambience background audio. Defaults to `true`. */
	ambience?: boolean
	/** Key-value context the agent can reference during the call. */
	context?: Record<string, string>
	/**
	 * What to extract from the call. Keys must match the type parameter `T`.
	 * Values are plain-English descriptions of what to extract.
	 */
	extract?: { [K in keyof T]: string }
	/** Maximum time to wait for the call to complete, in milliseconds. Defaults to 5 minutes. */
	timeoutMs?: number
	/** Polling interval when WebSocket is unavailable, in milliseconds. Defaults to 2 seconds. */
	pollIntervalMs?: number
	/** Per-tool execution timeout in milliseconds. Defaults to 30 seconds. */
	toolTimeoutMs?: number
	/** Deduplicate calls with the same key. */
	idempotencyKey?: string
}

// ── Call events ───────────────────────────────────────────────────────

/**
 * Agent or caller spoke.
 *
 * @example
 * ```typescript
 * call.on('speech', ({ role, text }) => {
 *   console.log(`[${role}] ${text}`)
 * })
 * ```
 */
export interface SpeechEvent {
	type: 'speech'
	role: 'agent' | 'caller'
	text: string
}

/**
 * The agent invoked a tool. The SDK executes it locally and sends the
 * result back automatically.
 */
export interface ToolCallEvent {
	type: 'tool_call'
	name: string
	args: Record<string, unknown>
}

/** A tool returned a result. */
export interface ToolResultEvent {
	type: 'tool_result'
	name: string
	result: string
}

/** A tool threw an error. */
export interface ToolErrorEvent {
	type: 'tool_error'
	name: string
	error: string
}

/** The call completed. */
export interface DoneEvent {
	type: 'done'
	goalAchieved: boolean
	goalAchievedReason: string
}

/** An error occurred during the call. */
export interface ErrorEvent {
	type: 'error'
	message: string
}

/** Union of all events emitted during a call. */
export type CallEvent = SpeechEvent | ToolCallEvent | ToolResultEvent | ToolErrorEvent | DoneEvent | ErrorEvent

/** Map from event type string to its event interface. Used by `.on()`. */
export interface CallEventMap {
	speech: SpeechEvent
	tool_call: ToolCallEvent
	tool_result: ToolResultEvent
	tool_error: ToolErrorEvent
	done: DoneEvent
	error: ErrorEvent
}

// ── Call result ───────────────────────────────────────────────────────

/** A single entry in the call transcript. */
export interface TranscriptEntry {
	role: 'agent' | 'caller'
	content: string
}

/**
 * The final result of a completed call. Discriminated on `status` —
 * narrow with `if (result.status === 'completed')` to access typed data.
 *
 * @typeParam T - Shape of the extracted data. Inferred from `CallOptions<T>`.
 *
 * @example
 * ```typescript
 * const result = await call.result
 * if (result.status === 'completed') {
 *   console.log(result.data.confirmed) // typed
 * } else {
 *   console.error(result.error)
 * }
 * ```
 */
export type CallResult<T extends Record<string, unknown> = Record<string, unknown>> =
	| {
			status: 'completed'
			id: string
			goalAchieved: boolean
			goalAchievedReason: string
			data: T
			transcript: TranscriptEntry[]
			duration: number
	  }
	| {
			status: 'failed'
			id: string
			error: string
	  }

// ── API wire types ────────────────────────────────────────────────────

/** @internal */
export interface ApiCall {
	id: string
	status: 'pending' | 'in_progress' | 'completed' | 'failed'
	transcript: TranscriptEntry[] | null
	result: Record<string, unknown> | null
	goalAchieved: boolean | null
	goalAchievedReason: string | null
	duration: number | null
	errorMessage: string | null
}

/** @internal */
export interface ApiAgent {
	id: string
	name: string
	goal: string
	voice: Voice
	context: Record<string, string>
	tools: ToolSchema[]
	results: Record<string, unknown>
}

/** @internal */
export interface CreateCallResponse {
	id: string
	status: ApiCall['status']
}

/** @internal */
export type ServerMessage =
	| { type: 'speech'; role: 'agent' | 'caller'; text: string }
	| { type: 'tool_call'; callbackId: string; toolName: string; toolArgs: Record<string, unknown> }
	| { type: 'done'; goalAchieved: boolean; goalAchievedReason: string }
	| { type: 'error'; message: string }
	| { type: 'call_status'; status: ApiCall['status'] }
