import { ApiError } from './errors.js'
import type { ApiCall, CreateCallResponse, MimicOptions, ToolSchema, Voice } from './types.js'

const SDK_VERSION = '0.1.0'
const MAX_RETRIES = 2
const INITIAL_RETRY_DELAY_MS = 500
const REQUEST_TIMEOUT_MS = 30_000

function normalizeBaseUrl(baseUrl?: string) {
	return (baseUrl ?? 'https://api.mimic.dev').replace(/\/+$/, '')
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
		this.userAgent = `@mimic/sdk/${SDK_VERSION} node/${typeof process !== 'undefined' ? process.version : 'unknown'}`
	}

	streamUrl(callId: string): string {
		const url = new URL(`${this.baseUrl}/api/v1/calls/${encodeURIComponent(callId)}/stream`)
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
		url.searchParams.set('token', this.apiKey)
		return url.toString()
	}

	async createCall(params: {
		goal: string
		to: string
		voice?: Voice
		context?: Record<string, string>
		tools?: ToolSchema[]
		extract?: Record<string, string>
		ambience?: boolean
		idempotencyKey?: string
	}): Promise<{ call: CreateCallResponse }> {
		const call = await this.request<CreateCallResponse>('/api/v1/calls', {
			method: 'POST',
			body: JSON.stringify({
				to: params.to,
				goal: params.goal,
				voice: params.voice ?? 'female',
				context: params.context ?? {},
				tools: params.tools ?? [],
				extract: params.extract ?? {},
				ambience: params.ambience,
				idempotencyKey: params.idempotencyKey,
			}),
		})

		return { call }
	}

	async getCall(id: string): Promise<ApiCall> {
		return this.request<ApiCall>(`/api/v1/calls/${encodeURIComponent(id)}`)
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
