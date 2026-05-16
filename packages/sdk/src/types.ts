// ── Client options ────────────────────────────────────────────────────

/** Options for creating a {@link Mimic} client. */
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
 * A tool function the voice agent can invoke during a call.
 *
 * Can be a plain function (name and parameters are introspected
 * automatically). Attach optional metadata to guide the agent:
 *
 * - `.description` — what the tool does
 * - `.params` — parameter descriptions (e.g. `{ date: 'The date to check in YYYY-MM-DD format' }`)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolFunction = ((...args: any[]) => any) & {
	description?: string
	params?: Record<string, string>
}

/** Wire format for tool definitions sent to the API. */
export interface ToolSchema {
	name: string
	description: string
	parameters: Record<string, string>
}

// ── Call options ───────────────────────────────────────────────────────

/** Full options object for {@link Mimic.call}. */
export interface CallOptions {
	/** Phone number to call (E.164 format, e.g. `'+15551234567'`). */
	to: string
	/** What the agent should accomplish on the call. */
	goal: string
	/** Tools the agent can use. Keys are tool names, values are functions. */
	tools?: Record<string, ToolFunction>
	/** Voice persona. Defaults to `'female'`. */
	voice?: Voice
	/** Key-value context the agent can reference (e.g. company info, caller details). */
	context?: Record<string, string>
	/** What to extract from the call. Keys are field names, values describe what to extract. */
	extract?: Record<string, string>
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

/** Agent or caller spoke. */
export interface SpeechEvent {
	type: 'speech'
	/** Who spoke. */
	role: 'agent' | 'caller'
	/** What was said. */
	text: string
}

/** The agent invoked a tool. */
export interface ToolCallEvent {
	type: 'tool_call'
	/** Tool name. */
	name: string
	/** Arguments the agent collected from the caller. */
	args: Record<string, unknown>
}

/** A tool returned a result. */
export interface ToolResultEvent {
	type: 'tool_result'
	/** Tool name. */
	name: string
	/** The result returned by the tool function. */
	result: string
}

/** A tool threw an error. */
export interface ToolErrorEvent {
	type: 'tool_error'
	/** Tool name. */
	name: string
	/** Error message. */
	error: string
}

/** The call ended. */
export interface DoneEvent {
	type: 'done'
	/** Whether the agent achieved its stated goal. */
	goalAchieved: boolean
	/** The agent's reasoning for the goal outcome. */
	goalAchievedReason: string
}

/** An error occurred during the call. */
export interface ErrorEvent {
	type: 'error'
	/** Error message. */
	message: string
}

/** Union of all events emitted during a call. */
export type CallEvent = SpeechEvent | ToolCallEvent | ToolResultEvent | ToolErrorEvent | DoneEvent | ErrorEvent

// ── Call result ───────────────────────────────────────────────────────

/** A single entry in the call transcript. */
export interface TranscriptEntry {
	/** Who spoke — `'agent'` or `'caller'`. */
	role: string
	/** What was said. */
	content: string
}

/** The final result of a completed call. */
export interface CallResult {
	/** Unique call identifier. */
	id: string
	/** Terminal status. */
	status: 'completed' | 'failed'
	/** Whether the agent achieved its stated goal. */
	goalAchieved: boolean
	/** The agent's reasoning for the goal outcome. */
	goalAchievedReason: string
	/** Structured data extracted from the call, shaped by `extract`. */
	data: Record<string, unknown>
	/** Full call transcript. */
	transcript: TranscriptEntry[]
	/** Call duration in seconds, or `null` if unavailable. */
	duration: number | null
}

// ── API wire types ────────────────────────────────────────────────────

/** @internal Call as returned by the API. */
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

/** @internal Agent as returned by the API (created implicitly). */
export interface ApiAgent {
	id: string
	name: string
	goal: string
	voice: Voice
	context: Record<string, string>
	tools: ToolSchema[]
	results: Record<string, unknown>
}

/** @internal Response from POST /calls. */
export interface CreateCallResponse {
	id: string
	status: ApiCall['status']
}

// ── Stream protocol ───────────────────────────────────────────────────

/** @internal Messages received from the server over WebSocket. */
export type ServerMessage =
	| { type: 'speech'; role: 'agent' | 'caller'; text: string }
	| { type: 'tool_call'; callbackId: string; toolName: string; toolArgs: Record<string, unknown> }
	| { type: 'done'; goalAchieved: boolean; goalAchievedReason: string }
	| { type: 'error'; message: string }
	| { type: 'call_status'; status: ApiCall['status'] }

