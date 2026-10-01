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
	/** Override the API base URL. Defaults to the hosted Mimic API (`https://api-production-6146.up.railway.app`). */
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

/**
 * A caller-owned system prompt for the voice agent. See {@link CallOptions.persona}.
 */
export interface Persona {
	/** Full system prompt for the voice agent. Used verbatim; max 48,000 characters. */
	systemPrompt: string
	/** Name the agent goes by on the call. Defaults to the voice's default name (Aurora / Arlo). */
	agentName?: string
}

// ── Tool types ────────────────────────────────────────────────────────

/**
 * A structured tool definition created by {@link tool}. The Zod schema
 * is the single source of truth for parameter names, types, and
 * descriptions. The `run` handler's input is inferred from the schema.
 *
 * @example
 * ```typescript
 * import { z } from 'zod'
 * import { tool } from '@underflowai/mimic'
 *
 * const checkCalendar = tool({
 *   description: 'Check available calendar slots',
 *   kind: 'read',
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
	/** Unspecified tools are treated as writes; reads must be declared explicitly. */
	kind?: 'read' | 'write'
	/** @internal Preserve the original schema of an MCP-discovered tool. */
	_mcpMeta?: { toolName: string; inputSchema: Record<string, unknown> }
	schema: ZodType
	run: (input: unknown) => Promise<string> | string
}

/**
 * A tool the agent can use during a call. Created via {@link tool}.
 */
export type ToolInput = MimicTool

/** @internal Wire format for tool definitions sent to the API. */
export interface ToolSchema {
	name: string
	description: string
	kind: 'read' | 'write'
	parameters: Record<string, unknown>
}

// ── Call options ───────────────────────────────────────────────────────

/**
 * Options for making a voice call via {@link Mimic.call}.
 *
 * @typeParam T - Shape of the structured data to extract from the call.
 *   Inferred from the `extract` Zod schema. Defaults to `{}`.
 *
 * @example
 * ```typescript
 * import { z } from 'zod'
 *
 * const call = mimic.call({
 *   to: '+15551234567',
 *   goal: 'Confirm the appointment',
 *   extract: z.object({
 *     confirmed: z.boolean().describe('whether confirmed'),
 *     notes: z.string().describe('any notes'),
 *   }),
 *   tools: { checkCalendar },
 * })
 * // result.data.confirmed → boolean | null
 * // result.data.notes → string | null
 * ```
 */
export interface CallOptions {
	/** Phone number to call (E.164 format, e.g. `'+15551234567'`). */
	to: string
	/** What the agent should accomplish on the call. */
	goal: string
	/** Tools the agent can use. Keys are tool names. */
	tools?: Record<string, ToolInput>
	/** Voice persona. Defaults to `'female'`. */
	voice?: Voice
	/** Caller timezone as an IANA name, e.g. America/New_York. Used to resolve relative dates and times. */
	userTimezone?: string
	/**
	 * Background knowledge the agent can reference — company info, policies,
	 * product details. Write it as a paragraph, like you'd brief a human.
	 *
	 * @example
	 * ```typescript
	 * context: `You're calling on behalf of Greenwood Medical. We require
	 * 24-hour cancellation notice. If they need to reschedule, collect their
	 * preferred date and time for the office to review. Dr. Smith is out on Fridays.`
	 * ```
	 */
	context?: string
	/**
	 * Structured data the agent should confirm or collect on the call.
	 * These become fields the agent walks through in conversation.
	 *
	 * @example
	 * ```typescript
	 * data: {
	 *   appointmentDate: 'Thursday May 16',
	 *   appointmentTime: '2:00 PM',
	 *   doctorName: 'Dr. Smith',
	 * }
	 * ```
	 */
	data?: Record<string, unknown>
	/**
	 * Who you're calling. Injected per-turn so the agent can use
	 * their name naturally. Does NOT affect the compiled prompt.
	 */
	recipient?: { firstName: string; lastName?: string; email?: string }
	/** Whether to proactively disclose AI status. Defaults to `true`. Recording notice/consent must be configured separately. */
	aiDisclosure?: boolean
	/** Office ambience background audio. Defaults to `true`. */
	ambience?: boolean
	/**
	 * Persona mode: supply the voice agent's system prompt directly and skip
	 * goal compilation. For callers that already maintain their own identity
	 * (e.g. a personal agent phoning its own user), compilation would only
	 * dilute the persona and add latency. `goal` is still required — the
	 * result extractor uses it as its rubric. `context`, `data`, and
	 * `recipient` are stored but not woven into the prompt; put anything the
	 * agent must know in `systemPrompt`.
	 *
	 * @example
	 * ```typescript
	 * persona: {
	 *   systemPrompt: 'You are Ripple, Ola's assistant. ...',
	 *   agentName: 'Ripple',
	 * }
	 * ```
	 */
	persona?: Persona
	/**
	 * URL to POST a `call.completed` event to when the call finishes.
	 * Must be an http(s) URL.
	 */
	webhook?: string
	/**
	 * What to extract from the call. Pass a Zod object schema — types
	 * describe known values in `result.data`. Every field can also be null
	 * when the call did not establish a value, even if the input schema is nonnullable.
	 * Use `.describe()` on each field to tell the agent what to extract.
	 *
	 * @example
	 * ```typescript
	 * extract: z.object({
	 *   confirmed: z.boolean().describe('whether confirmed'),
	 *   notes: z.string().nullable().describe('any notes'),
	 * })
	 * ```
	 */
	extract?: import('zod').ZodObject<Record<string, import('zod').ZodType>>
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

/** Extracted values preserve unknown information as null, including required fields. */
export type ExtractedData<T extends Record<string, unknown>> = {
	[K in keyof T]-?: Exclude<T[K], undefined> | null
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
			data: ExtractedData<T>
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
	status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
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
