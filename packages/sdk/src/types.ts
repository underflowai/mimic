/** Voice persona for the agent. */
export type Voice = 'female' | 'male'

/**
 * How the platform evaluates whether the call achieved its goal.
 *
 * - `llm_evaluated` — the LLM decides based on the conversation (default).
 * - `tool_called` — goal is achieved when the named tool is successfully called.
 * - `field_filled` — goal is achieved when the named result field has a value.
 */
export type SuccessCondition =
	| { type: 'llm_evaluated' }
	| { type: 'tool_called'; toolName: string }
	| { type: 'field_filled'; fieldName: string }

/** A single entry in the call transcript. */
export interface TranscriptEntry {
	/** Who spoke — typically `'user'` (caller) or `'assistant'` (agent). */
	role: string
	/** What was said. */
	content: string
}

/** Allowed types for tool parameters. */
export type ToolParameterType = 'string' | 'number' | 'boolean'

/** Describes a single parameter that a tool accepts. */
export interface ToolParameter {
	/** The data type of this parameter. */
	type: ToolParameterType
	/** Human-readable description. Helps the voice agent collect the right value from the caller. */
	description?: string
	/** Whether this parameter is required. Defaults to `true`. */
	required?: boolean
}

/**
 * A tool the voice agent can use during a call.
 *
 * The `description` and `parameters` are sent to the server so the agent knows when and how
 * to invoke the tool. The `run` function executes locally in your process — your secrets and
 * APIs never leave your machine.
 */
export interface MimicTool {
	/** What this tool does. The agent uses this to decide when to call it. */
	description: string
	/** Parameters the tool accepts. The agent collects these from the caller before invoking. */
	parameters?: Record<string, ToolParameter>
	/**
	 * Execute the tool locally. Receives the arguments the agent collected from the caller.
	 * Return a string result that the agent will relay back to the caller.
	 */
	run?: (args: Record<string, unknown>) => Promise<string> | string
}

/** Wire format for tool definitions sent to the API. */
export interface ToolDefinition {
	name: string
	description: string
	parameters: Record<string, string>
}

/** Options for creating an {@link Mimic} client. */
export interface MimicOptions {
	/** Your Mimic API key. Starts with `mk_`. */
	apiKey: string
	/** Override the API base URL. Defaults to `https://api.mimic.dev`. */
	baseUrl?: string
	/** Custom `fetch` implementation. Defaults to the global `fetch`. */
	fetch?: typeof fetch
	/** Custom `WebSocket` constructor. Defaults to the global `WebSocket`. */
	WebSocket?: typeof WebSocket
}

/** Options for creating a reusable voice agent. */
export interface CreateAgentOptions {
	/** Display name for the agent. Defaults to the first 80 characters of the goal. */
	name?: string
	/** What the agent should accomplish on the call. Be specific and outcome-oriented. */
	goal: string
	/** Voice persona. Defaults to `'female'`. */
	voice?: Voice
	/** Key-value context the agent can reference during the call (e.g. company info, FAQs, background knowledge). */
	context?: Record<string, string>
	/** Structured data the agent should confirm or collect (supports nested objects, arrays, and constrained fields). */
	data?: Record<string, unknown>
	/** Tools the agent can use. Keys are tool names, values define behavior and local execution. */
	tools?: Record<string, MimicTool>
	/** What the agent should extract from the call. Keys are field names, values describe what to extract. */
	results?: Record<string, unknown>
	/** How to determine if the call achieved its goal. Defaults to LLM evaluation. */
	successCondition?: SuccessCondition
	/** URL to receive a webhook when the call completes. */
	webhook?: string
}

/** Options for updating an existing agent. All fields are optional. */
export interface UpdateAgentOptions {
	name?: string
	webhook?: string | null
	phoneNumber?: string | null
	systemPrompt?: string
	turnControlBlock?: string | null
	agentName?: string
}

/**
 * Options for making a one-shot call. Extends {@link CreateAgentOptions} with
 * the phone number to call and polling configuration.
 *
 * @typeParam T - Shape of the structured data returned in {@link CallResult.data}.
 */
export interface CallOptions<T extends Record<string, unknown> = Record<string, unknown>> extends CreateAgentOptions {
	/** Phone number to call (E.164 format, e.g. `'+15551234567'`). */
	to: string
	/** What to extract from the call. Keys must match the type parameter `T`. */
	results?: { [K in keyof T]: unknown }
	/** Deduplicate calls with the same key. If a call with this key already exists, it is returned instead. */
	idempotencyKey?: string
	/** Maximum time to wait for the call to complete, in milliseconds. Defaults to 5 minutes. */
	timeoutMs?: number
	/** How often to poll for call status, in milliseconds. Defaults to 2 seconds. */
	pollIntervalMs?: number
}

/** Options for calling with a reusable agent. */
export interface AgentCallOptions {
	/** Phone number to call (E.164 format). */
	to: string
	/** Per-call context that overrides or extends the agent's default context. */
	context?: Record<string, string>
	/** Deduplicate calls with the same key. */
	idempotencyKey?: string
	/** Maximum time to wait for completion, in milliseconds. Defaults to 5 minutes. */
	timeoutMs?: number
	/** Poll interval in milliseconds. Defaults to 2 seconds. */
	pollIntervalMs?: number
}

/** An agent as returned by the API. */
export interface ApiAgent {
	id: string
	name: string
	goal: string
	voice: Voice
	context: Record<string, string>
	data?: Record<string, unknown>
	tools: ToolDefinition[]
	results: Record<string, unknown>
}

/** A call as returned by the API (may be in-progress). */
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

/**
 * The result of a completed call.
 *
 * @typeParam T - Shape of the structured data in {@link data}. Pass a type parameter
 * to `call<T>()` and define a matching `results` to get typed access.
 */
export interface CallResult<T extends Record<string, unknown> = Record<string, unknown>> {
	/** Unique call identifier. */
	id: string
	/** Terminal status. */
	status: 'completed' | 'failed'
	/** Whether the agent achieved its stated goal. */
	goalAchieved: boolean
	/** The agent's reasoning for the goal outcome. */
	goalAchievedReason: string
	/** Structured data extracted from the call, shaped by `results`. */
	data: T
	/** Full call transcript. */
	transcript: TranscriptEntry[]
	/** Call duration in seconds, or `null` if unavailable. */
	duration: number | null
}
