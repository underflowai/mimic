import type { ZodObject, ZodType } from 'zod'

/** A Zod object schema describing what to extract from a call. */
export type ExtractSchema = ZodObject<Record<string, ZodType>>

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
 * Who the agent is and what it is trying to do. Written once, reused for
 * every call. Get one from {@link Mimic.compile} or write it yourself, then
 * pass it as {@link CallOptions.prompt}. It is used verbatim and never
 * recompiled; per-call `data`, `extract`, and `recipient` are appended to it
 * at runtime.
 */
export interface Prompt {
	/** What the agent is trying to accomplish, in a sentence or two. Judges whether a call succeeded. */
	goal: string
	/** The agent's system prompt. Used verbatim; max 48,000 characters. */
	systemPrompt: string
	/** Per-turn speaking guidance. {@link Mimic.compile} fills this in; optional for hand-written prompts. */
	turnControlBlock?: string | null
	/** Name the agent goes by on the call. Defaults to the voice's name (Aurora / Arlo). */
	agentName?: string
}

/** Options for {@link Mimic.compile}: the job, not any one call. */
export interface CompileOptions {
	/** What the agent should accomplish. */
	goal: string
	/** Background the agent can rely on. See {@link CallOptions.context}. */
	context?: string
	/** Tools the agent will have. Only their names, descriptions, and parameters are used here. */
	tools?: Record<string, ToolInput>
	/** Voice the prompt is written for. Defaults to `'female'`. */
	voice?: Voice
	/** Whether the agent should proactively disclose it is AI. Defaults to `true`. */
	aiDisclosure?: boolean
	/** `'phone'` (default) or `'web'`. Web prompts avoid phone language. */
	channel?: CallChannel
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
	/**
	 * `'read'` (default) runs as soon as the request is clear; `'write'` waits for
	 * the caller's explicit go-ahead. MCP tools follow their `readOnlyHint`
	 * annotation instead: read only when the server marks them read-only.
	 */
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

/** How the other person joins the call. */
export type CallChannel = 'phone' | 'web'

/**
 * What a browser needs to join a web call. Pass both to `livekit-client`:
 * `await room.connect(url, token)`.
 */
export interface WebJoin {
	/** LiveKit server URL. */
	url: string
	/** Join token scoped to this call's room. Valid for one hour. */
	token: string
}

/**
 * Options for making a voice call via {@link Mimic.call}. Pass either a
 * `goal` (Mimic compiles a prompt from it and caches the result) or a
 * `prompt` you own (used verbatim, never recompiled).
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
export type CallOptions = CallOptionsBase & AgentSpec

/** @internal Exactly one of `goal` or `prompt` defines the agent. */
export type AgentSpec =
	| {
			/** What the agent should accomplish. Compiled into a prompt once per distinct goal, then cached. */
			goal: string
			prompt?: undefined
	  }
	| {
			/** A prompt you own, from {@link Mimic.compile} or hand-written. Used verbatim. */
			prompt: Prompt
			goal?: undefined
	  }

/** Everything about a call other than how the agent is defined. */
export interface CallOptionsBase {
	/**
	 * `'phone'` (default) dials `to`. `'web'` places nobody: the API returns a
	 * {@link WebJoin} on `call.web` and the person joins from a browser.
	 */
	channel?: CallChannel
	/** Phone number to call (E.164 format, e.g. `'+15551234567'`). Required for phone calls. */
	to?: string
	/** Tools the agent can use. Keys are tool names. */
	tools?: Record<string, ToolInput>
	/** Voice persona. Defaults to `'female'`. */
	voice?: Voice
	/**
	 * Caller timezone as an IANA name, e.g. America/New_York. Used to resolve
	 * relative dates and times. When omitted, the server guesses from the
	 * phone number's area code and the agent confirms the guess with the caller
	 * before relying on it.
	 */
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
	 * Facts for this call: what the agent should confirm, use, or collect.
	 * Appended to the prompt at runtime, so they never cause a recompile;
	 * fifty calls with fifty different values share one prompt.
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
	 * URL that receives `{ event: 'call.completed' | 'call.failed', call: Call }`
	 * when the call ends, whatever your process is doing by then. Retried a few
	 * times on failure. Must be an http(s) URL.
	 */
	webhook?: string
	/**
	 * Signs each webhook delivery so you can tell it came from Mimic. Check it
	 * with {@link verifyWebhook}. Requires `webhook`.
	 */
	webhookSecret?: string
	/**
	 * What you want back from the call. Pass a Zod object schema; `result.data`
	 * is typed from it. Fields can be strings, numbers, booleans, enums, or
	 * arrays of those. Every field can also be null when the call did not
	 * establish a value, even if the schema is nonnullable. Use `.describe()`
	 * on each field so the agent knows what to find out. Shown to the agent at
	 * runtime; changing it never recompiles the prompt.
	 *
	 * @example
	 * ```typescript
	 * extract: z.object({
	 *   outcome: z.enum(['confirmed', 'rescheduled', 'declined']).describe('what they decided'),
	 *   concerns: z.array(z.string()).describe('anything they were worried about'),
	 *   notes: z.string().nullable().describe('any notes'),
	 * })
	 * ```
	 */
	extract?: ExtractSchema
	/**
	 * How long to wait for the call to end, in milliseconds. When it elapses the
	 * call is cancelled and `.result` rejects with {@link CallTimeoutError}.
	 * Defaults to 60 minutes, which is also the longest a call can run.
	 */
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

// ── Call records ──────────────────────────────────────────────────────

/** A single entry in the call transcript. */
export interface TranscriptEntry {
	role: 'agent' | 'caller'
	content: string
}

/** A tool the agent used during the call, with what it sent and got back. */
export interface ToolCallRecord {
	name: string
	input: unknown
	output: unknown
	success?: boolean
}

/** Where a call is in its life. `cancelled` is a call you ended with `cancel`. */
export type CallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

/**
 * A call as the API records it: what {@link Mimic.calls} returns and what a
 * webhook delivers. `data` holds the `extract` values once the call has ended.
 */
export interface Call {
	id: string
	status: CallStatus
	channel: CallChannel
	/** Number dialed (E.164); null for web calls. */
	to: string | null
	/** ISO 8601 timestamp of when the call was created. */
	createdAt: string
	/** Seconds on the call; null until it ends. */
	duration: number | null
	goalAchieved: boolean | null
	goalAchievedReason: string | null
	/** Extracted values; unknown ones are null. Null until the call ends. */
	data: Record<string, unknown> | null
	transcript: TranscriptEntry[]
	toolCalls: ToolCallRecord[]
	/** Why the call failed or was cancelled; null otherwise. */
	error: string | null
	/** Signed link to the recording, valid for one hour. Null when there is no recording (yet). */
	recordingUrl: string | null
}

/** Options for {@link Mimic.calls.list}. */
export interface ListCallsOptions {
	/** Page size, 1–100. Defaults to 20. */
	limit?: number
	/** `nextCursor` from the previous page. */
	cursor?: string
	/** Only calls in this state. */
	status?: CallStatus
}

/** One page of calls, newest first. */
export interface CallPage {
	calls: Call[]
	/** Pass as `cursor` to get the next page; null on the last page. */
	nextCursor: string | null
}

/**
 * Webhook payload. Delivered once a call ends: `call.completed` when it ran to
 * the end, `call.failed` when it failed or was cancelled (see `call.status`).
 */
export interface WebhookEvent {
	event: 'call.completed' | 'call.failed'
	call: Call
}

// ── Call result ───────────────────────────────────────────────────────

/** Extracted values preserve unknown information as null, including required fields. */
export type ExtractedData<T extends Record<string, unknown>> = {
	[K in keyof T]-?: Exclude<T[K], undefined> | null
}

/**
 * The final result of a completed call. Discriminated on `status` —
 * narrow with `if (result.status === 'completed')` to access typed data.
 *
 * @typeParam T - Shape of the extracted data. Inferred from the `extract` schema.
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
			toolCalls: ToolCallRecord[]
			duration: number
			/** Signed link to the recording, valid for one hour; `mimic.calls.get(id)` issues a fresh one. */
			recordingUrl: string | null
	  }
	| {
			status: 'failed'
			id: string
			error: string
	  }

// ── API wire types ────────────────────────────────────────────────────

/** @internal */
export interface CreateCallResponse {
	id: string
	status: CallStatus
	/** Present for web calls that can still be joined. */
	web?: WebJoin
}

/** @internal */
export type ServerMessage =
	| { type: 'speech'; role: 'agent' | 'caller'; text: string }
	| { type: 'tool_call'; callbackId: string; toolName: string; toolArgs: Record<string, unknown> }
	| { type: 'done'; goalAchieved: boolean; goalAchievedReason: string }
	| { type: 'error'; message: string }
	| { type: 'call_status'; status: CallStatus }
