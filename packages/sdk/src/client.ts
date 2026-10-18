import { ApiError } from './errors.js'
import { introspectTools } from './tools.js'
import type {
	Call,
	CallChannel,
	CallOptions,
	CallPage,
	CallStatus,
	CreateCallResponse,
	ExtractSchema,
	ListCallsOptions,
	MimicOptions,
	Prompt,
	ToolSchema,
	Voice,
} from './types.js'
import { SDK_VERSION } from './version.js'

/** Wire form of one `extract` field. The server reads string, number, boolean, enum, and arrays of those. */
interface ExtractField {
	type: string
	description: string
	nullable?: boolean
	optional?: boolean
	enum?: string[]
	items?: string
}

export function serializeExtractSchema(schema?: ExtractSchema): Record<string, ExtractField> | undefined {
	const shape = schema?.shape
	if (!shape) return undefined
	const result: Record<string, ExtractField> = {}
	for (const [key, field] of Object.entries(shape)) {
		const description = (field as { description?: string }).description ?? key
		result[key] = { ...describeZodField(field), description }
	}
	return result
}

/**
 * One field's definition. Zod 3 keeps it on `_def` with a `typeName` like
 * `ZodNullable`; Zod 4 on `_zod.def` with a `type` like `nullable`. Wrappers
 * point at `innerType` in both; arrays hold their element in `type` (3) or
 * `element` (4); enums list `values` (3) or `entries` (4).
 */
interface ZodFieldDef {
	typeName?: string
	type?: unknown
	innerType?: unknown
	element?: unknown
	values?: string[]
	entries?: Record<string, unknown>
}

function describeZodField(field: unknown): Omit<ExtractField, 'description'> {
	const def =
		(field as { _zod?: { def?: ZodFieldDef }; _def?: ZodFieldDef } | null)?._zod?.def ??
		(field as { _def?: ZodFieldDef } | null)?._def
	if (!def) return { type: 'string' }
	const kind = (def.typeName ?? (typeof def.type === 'string' ? def.type : '')).replace(/^Zod/, '').toLowerCase()
	switch (kind) {
		case 'nullable':
			return { ...describeZodField(def.innerType), nullable: true }
		case 'optional':
		case 'default':
			return { ...describeZodField(def.innerType), optional: true }
		case 'enum':
			return { type: 'string', enum: def.values ?? Object.values(def.entries ?? {}).map(String) }
		case 'array':
			return { type: 'array', items: describeZodField(def.element ?? def.type).type }
		default:
			return { type: kind || 'string' }
	}
}

/** Hosted Mimic API. `mimic.dev` is not provisioned; this is the live Railway domain. */
const DEFAULT_BASE_URL = 'https://api-production-6146.up.railway.app'
const MAX_RETRIES = 2
const INITIAL_RETRY_DELAY_MS = 500
const REQUEST_TIMEOUT_MS = 30_000

function normalizeBaseUrl(baseUrl?: string) {
	return (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function isRetryable(status: number): boolean {
	return status === 408 || status === 429 || status >= 500
}

function retryDelay(attempt: number): number {
	return INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt) + Math.random() * 100
}

/**
 * Thin HTTP client for the Mimic API with retries and timeouts.
 *
 * @internal
 */
export class MimicClient {
	readonly baseUrl: string
	private readonly fetchImpl: typeof fetch
	private readonly apiKey: string
	private readonly userAgent: string

	constructor(options: MimicOptions) {
		this.apiKey = options.apiKey
		this.baseUrl = normalizeBaseUrl(options.baseUrl)
		this.fetchImpl = options.fetch ?? fetch
		this.userAgent = `@underflowai/mimic/${SDK_VERSION} node/${typeof process !== 'undefined' ? process.version : 'unknown'}`
	}

	streamUrl(callId: string): string {
		const url = new URL(`${this.baseUrl}/api/v1/calls/${encodeURIComponent(callId)}/stream`)
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
		return url.toString()
	}

	/** First frame on the stream. `tools: false` only listens, so it can sit beside the connection that runs the call's tools. */
	streamAuthPayload(options: { tools: boolean } = { tools: true }): string {
		return JSON.stringify({ type: 'auth', token: this.apiKey, ...(options.tools ? {} : { tools: false }) })
	}

	async compilePrompt(params: {
		goal: string
		context?: string
		tools?: ToolSchema[]
		voice?: Voice
		aiDisclosure?: boolean
		channel?: CallChannel
	}): Promise<Prompt> {
		return this.request<Prompt>('/api/v1/prompts/compile', {
			method: 'POST',
			body: JSON.stringify(params),
		})
	}

	async createCall(options: CallOptions): Promise<CreateCallResponse> {
		return this.request<CreateCallResponse>('/api/v1/calls', {
			method: 'POST',
			body: JSON.stringify({
				channel: options.channel,
				to: options.to,
				goal: options.goal,
				prompt: options.prompt,
				voice: options.voice ?? 'female',
				userTimezone: options.userTimezone,
				context: options.context,
				data: options.data,
				recipient: options.recipient,
				aiDisclosure: options.aiDisclosure,
				tools: options.tools ? introspectTools(options.tools) : [],
				extract: serializeExtractSchema(options.extract),
				ambience: options.ambience,
				webhook: options.webhook,
				webhookSecret: options.webhookSecret,
				idempotencyKey: options.idempotencyKey,
			}),
		})
	}

	async getCall(id: string): Promise<Call> {
		return this.request<Call>(`/api/v1/calls/${encodeURIComponent(id)}`)
	}

	async listCalls(options: ListCallsOptions = {}): Promise<CallPage> {
		const query = new URLSearchParams()
		if (options.limit !== undefined) query.set('limit', String(options.limit))
		if (options.cursor) query.set('cursor', options.cursor)
		if (options.status) query.set('status', options.status)
		const suffix = query.size > 0 ? `?${query}` : ''
		return this.request<CallPage>(`/api/v1/calls${suffix}`)
	}

	async cancelCall(id: string): Promise<{ id: string; status: CallStatus }> {
		return this.request<{ id: string; status: CallStatus }>(`/api/v1/calls/${encodeURIComponent(id)}`, {
			method: 'DELETE',
		})
	}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		let lastError: Error | null = null

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			if (attempt > 0) {
				await new Promise((r) => setTimeout(r, retryDelay(attempt - 1)))
			}

			const abort = new AbortController()
			const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS)

			try {
				const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
					...init,
					signal: abort.signal,
					headers: {
						authorization: `Bearer ${this.apiKey}`,
						'content-type': 'application/json',
						'user-agent': this.userAgent,
						...init.headers,
					},
				})

				clearTimeout(timeout)

				const text = await response.text()
				const body = text ? (JSON.parse(text) as unknown) : null

				if (!response.ok) {
					const message =
						body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
							? body.error
							: `Mimic API request failed with ${response.status}`
					const err = new ApiError(message, response.status, body)

					if (isRetryable(response.status) && attempt < MAX_RETRIES) {
						lastError = err
						continue
					}
					throw err
				}

				return body as T
			} catch (err) {
				clearTimeout(timeout)

				if (err instanceof ApiError) throw err

				// Network error or timeout — retryable
				lastError = err instanceof Error ? err : new Error(String(err))
				if (attempt < MAX_RETRIES) continue
				throw lastError
			}
		}

		throw lastError ?? new Error('Request failed')
	}
}
