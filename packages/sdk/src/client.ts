import { ApiError } from './errors.js'
import type {
	ApiAgent,
	ApiCall,
	CreateAgentOptions,
	ToolDefinition,
	ToolParameter,
	MimicOptions,
	MimicTool,
	UpdateAgentOptions,
} from './types.js'

export interface CreateCallResponse {
	id: string
	status: ApiCall['status']
}

function normalizeBaseUrl(baseUrl?: string) {
	return (baseUrl ?? 'https://api.mimic.dev').replace(/\/+$/, '')
}

function serializeParameter(param: ToolParameter): string {
	const parts: string[] = [param.type]
	if (param.description) parts.push(`— ${param.description}`)
	if (param.required === false) parts.push('(optional)')
	return parts.join(' ')
}

export function toToolDefinitions(tools?: Record<string, MimicTool>): ToolDefinition[] {
	return Object.entries(tools ?? {}).map(([name, tool]) => ({
		name,
		description: tool.description,
		parameters: Object.fromEntries(
			Object.entries(tool.parameters ?? {}).map(([key, param]) => [key, serializeParameter(param)]),
		),
	}))
}

export class MimicClient {
	readonly baseUrl: string
	private readonly fetchImpl: typeof fetch
	private readonly apiKey: string

	constructor(options: MimicOptions) {
		this.apiKey = options.apiKey
		this.baseUrl = normalizeBaseUrl(options.baseUrl)
		this.fetchImpl = options.fetch ?? fetch
	}

	toolSocketUrl(callId: string) {
		const url = new URL(`${this.baseUrl}/api/v1/calls/${encodeURIComponent(callId)}/tools`)
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
		url.searchParams.set('token', this.apiKey)
		return url.toString()
	}

	async createAgent(options: CreateAgentOptions): Promise<ApiAgent> {
		return this.request<ApiAgent>('/api/v1/agents', {
			method: 'POST',
			body: JSON.stringify({
				name: options.name ?? (options.goal.slice(0, 80) || 'voice agent'),
				goal: options.goal,
				voice: options.voice ?? 'female',
				context: options.context ?? {},
				data: options.data ?? {},
				tools: toToolDefinitions(options.tools),
				results: options.results ?? {},
				successCondition: options.successCondition,
				webhook: options.webhook,
			}),
		})
	}

	async getAgent(id: string): Promise<ApiAgent> {
		return this.request<ApiAgent>(`/api/v1/agents/${encodeURIComponent(id)}`)
	}

	async updateAgent(id: string, options: UpdateAgentOptions): Promise<ApiAgent> {
		return this.request<ApiAgent>(`/api/v1/agents/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			body: JSON.stringify(options),
		})
	}

	async createCall(params: {
		agentId: string
		to: string
		context?: Record<string, string>
		idempotencyKey?: string
	}): Promise<CreateCallResponse> {
		return this.request<CreateCallResponse>('/api/v1/calls', {
			method: 'POST',
			body: JSON.stringify({
				agentId: params.agentId,
				to: params.to,
				context: params.context ?? {},
				idempotencyKey: params.idempotencyKey,
			}),
		})
	}

	async getCall(id: string): Promise<ApiCall> {
		return this.request<ApiCall>(`/api/v1/calls/${encodeURIComponent(id)}`)
	}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${this.apiKey}`,
				'content-type': 'application/json',
				...init.headers,
			},
		})
		const text = await response.text()
		const body = text ? (JSON.parse(text) as unknown) : null
		if (!response.ok) {
			const message =
				body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
					? body.error
					: `Mimic API request failed with ${response.status}`
			throw new ApiError(message, response.status, body)
		}
		return body as T
	}
}
