import { ApiError } from './errors.js'
import { ZodObject, type ZodType } from 'zod'

import type {
	Call,
	CallChannel,
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
	if (!schema || !(schema instanceof ZodObject)) return undefined
	const shape = schema.shape as Record<string, ZodType>
	const result: Record<string, ExtractField> = {}
	for (const [key, field] of Object.entries(shape)) {
		const description = field.description ?? key
		const nullable = field.isNullable()
		const optional = field.isOptional()
		result[key] = {
			...describeZodType(field),
			description,
			...(nullable && { nullable }),
			...(optional && { optional }),
		}
	}
	return result
}

type ZodDef = { typeName?: string; innerType?: ZodType; type?: ZodType; values?: string[] }

function describeZodType(field: ZodType): Pick<ExtractField, 'type' | 'enum' | 'items'> {
	// Walk through nullable/optional wrappers to find the base type
	const def = (field as { _def?: ZodDef })._def
	if (!def) return { type: 'string' }
	if (
		(def.typeName === 'ZodNullable' || def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault') &&
		def.innerType
	) {
		return describeZodType(def.innerType)
	}
	if (def.typeName === 'ZodEnum' && def.values) return { type: 'string', enum: def.values }
	if (def.typeName === 'ZodArray' && def.type) return { type: 'array', items: describeZodType(def.type).type }
	const name = def.typeName?.replace('Zod', '').toLowerCase()
	return { type: name ?? 'string' }
}

import { SDK_VERSION } from './version.js'
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

	streamAuthPayload(): string {
		return JSON.stringify({ type: 'auth', token: this.apiKey })
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

	async createCall(params: {
		goal?: string
		prompt?: Prompt
		channel?: CallChannel
		to?: string
		voice?: Voice
		userTimezone?: string
		context?: string
		data?: Record<string, unknown>
		recipient?: { firstName: string; lastName?: string; email?: string }
		aiDisclosure?: boolean
		tools?: ToolSchema[]
		extract?: ExtractSchema
		ambience?: boolean
		webhook?: string
		webhookSecret?: string
		idempotencyKey?: string
	}): Promise<{ call: CreateCallResponse }> {
		const call = await this.request<CreateCallResponse>('/api/v1/calls', {
			method: 'POST',
			body: JSON.stringify({
				channel: params.channel,
				to: params.to,
				goal: params.goal,
				prompt: params.prompt,
				voice: params.voice ?? 'female',
				userTimezone: params.userTimezone,
				context: params.context,
				data: params.data,
				recipient: params.recipient,
				aiDisclosure: params.aiDisclosure,
				tools: params.tools ?? [],
				extract: serializeExtractSchema(params.extract),
				ambience: params.ambience,
				webhook: params.webhook,
				webhookSecret: params.webhookSecret,
				idempotencyKey: params.idempotencyKey,
			}),
		})

		return { call }
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
