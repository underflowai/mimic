import { runAgentCall, runCall } from './call.js'
import { MimicClient } from './client.js'
import type {
	AgentCallOptions,
	ApiAgent,
	CallOptions,
	CallResult,
	CreateAgentOptions,
	MimicOptions,
	UpdateAgentOptions,
} from './types.js'

/**
 * The main Mimic client. Create an instance with your API key, then
 * make calls or manage agents.
 *
 * @example
 * ```typescript
 * const uf = new Mimic({ apiKey: 'mk_...' })
 *
 * const result = await uf.call({
 *   to: '+15551234567',
 *   goal: 'Confirm the appointment for tomorrow at 2pm',
 * })
 * ```
 */
export class Mimic {
	private readonly client: MimicClient
	private readonly WebSocketImpl?: MimicOptions['WebSocket']

	constructor(options: MimicOptions) {
		this.client = new MimicClient(options)
		this.WebSocketImpl = options.WebSocket
	}

	/**
	 * Make a one-shot voice call. Creates an agent behind the scenes, starts the call,
	 * and polls until it completes or times out.
	 *
	 * @typeParam T - Shape of the structured data returned in `result.data`.
	 * @param options - Call configuration including phone number, goal, tools, and result schema.
	 * @returns The completed call result with transcript, extracted data, and goal outcome.
	 * @throws {@link CallTimeoutError} if the call doesn't complete within `timeoutMs`.
	 * @throws {@link CallFailedError} if the call reaches a terminal failed state.
	 */
	call<T extends Record<string, unknown> = Record<string, unknown>>(options: CallOptions<T>): Promise<CallResult<T>> {
		return runCall<T>(this.client, options, this.WebSocketImpl)
	}

	/**
	 * Create a reusable agent. Use this when making multiple calls with the same
	 * configuration — the agent is created once and can call many numbers.
	 *
	 * @param options - Agent configuration including goal, tools, and result schema.
	 * @returns An {@link MimicAgent} that can make calls.
	 */
	async createAgent(options: CreateAgentOptions): Promise<MimicAgent> {
		const agent = await this.client.createAgent(options)
		return new MimicAgent(this.client, agent, options, this.WebSocketImpl)
	}

	/**
	 * Fetch an existing agent by ID.
	 *
	 * @param id - The agent's unique identifier.
	 * @returns An {@link MimicAgent} wrapping the fetched agent.
	 * @throws {@link ApiError} with code `'not_found'` if the agent doesn't exist.
	 */
	async getAgent(id: string): Promise<MimicAgent> {
		const agent = await this.client.getAgent(id)
		return new MimicAgent(this.client, agent, {}, this.WebSocketImpl)
	}

	/**
	 * Update an existing agent's configuration.
	 *
	 * @param id - The agent's unique identifier.
	 * @param options - Fields to update. Only provided fields are changed.
	 * @returns An {@link MimicAgent} wrapping the updated agent.
	 */
	async updateAgent(id: string, options: UpdateAgentOptions): Promise<MimicAgent> {
		const agent = await this.client.updateAgent(id, options)
		return new MimicAgent(this.client, agent, {}, this.WebSocketImpl)
	}

	/**
	 * Fetch the current state of a call by ID.
	 *
	 * @param id - The call's unique identifier.
	 * @returns The call result (may be in-progress with partial data).
	 */
	async getCall(id: string): Promise<CallResult> {
		const call = await this.client.getCall(id)
		return {
			id: call.id,
			status: call.status === 'failed' ? ('failed' as const) : ('completed' as const),
			goalAchieved: call.goalAchieved ?? false,
			goalAchievedReason: call.goalAchievedReason ?? '',
			data: call.result ?? {},
			transcript: call.transcript ?? [],
			duration: call.duration,
		}
	}
}

/**
 * A reusable voice agent. Created via {@link Mimic.createAgent} or
 * {@link Mimic.getAgent}. Call `.call()` to make outbound calls with
 * this agent's configuration.
 */
export class MimicAgent {
	constructor(
		private readonly client: MimicClient,
		/** The underlying API agent data. */
		readonly agent: ApiAgent,
		private readonly options: Pick<CreateAgentOptions, 'tools'>,
		private readonly WebSocketImpl?: MimicOptions['WebSocket'],
	) {}

	/**
	 * Make a call with this agent.
	 *
	 * @typeParam T - Shape of the structured data returned in `result.data`.
	 * @param to - Phone number to call (E.164 format).
	 * @param options - Per-call overrides (context, timeout, idempotency key).
	 */
	call<T extends Record<string, unknown> = Record<string, unknown>>(
		to: string,
		options?: Omit<AgentCallOptions, 'to'>,
	): Promise<CallResult<T>>
	/**
	 * Make a call with this agent.
	 *
	 * @typeParam T - Shape of the structured data returned in `result.data`.
	 * @param options - Call options including phone number.
	 */
	call<T extends Record<string, unknown> = Record<string, unknown>>(options: AgentCallOptions): Promise<CallResult<T>>
	call<T extends Record<string, unknown> = Record<string, unknown>>(
		input: string | AgentCallOptions,
		options: Omit<AgentCallOptions, 'to'> = {},
	): Promise<CallResult<T>> {
		const callOptions = typeof input === 'string' ? { ...options, to: input } : input
		return runAgentCall<T>(this.client, this.agent, this.options, callOptions, this.WebSocketImpl)
	}
}
