import { MimicClient } from './client.js'
import { CallFailedError, CallTimeoutError, MimicError } from './errors.js'
import { connectToolCallbacks, type WebSocketConstructor } from './tools.js'
import type { AgentCallOptions, ApiAgent, ApiCall, CallOptions, CallResult, CreateAgentOptions } from './types.js'

const defaultTimeoutMs = 5 * 60_000
const defaultPollIntervalMs = 2_000

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function toCallResult<T extends Record<string, unknown> = Record<string, unknown>>(call: ApiCall): CallResult<T> {
	if (call.status === 'completed' && (call.goalAchieved === null || call.result === null || call.transcript === null)) {
		throw new MimicError(
			`Call ${call.id} completed but has missing fields (goalAchieved=${call.goalAchieved}, result=${call.result !== null}, transcript=${call.transcript !== null})`,
		)
	}
	return {
		id: call.id,
		status: call.status === 'failed' ? ('failed' as const) : ('completed' as const),
		goalAchieved: call.goalAchieved ?? false,
		goalAchievedReason: call.goalAchievedReason ?? '',
		data: (call.result ?? {}) as T,
		transcript: call.transcript ?? [],
		duration: call.duration,
	}
}

async function pollCall<T extends Record<string, unknown> = Record<string, unknown>>(
	client: MimicClient,
	callId: string,
	options: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<CallResult<T>> {
	const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
	const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		const call = await client.getCall(callId)
		if (call.status === 'completed') return toCallResult<T>(call)
		if (call.status === 'failed') {
			throw new CallFailedError(call.errorMessage ?? 'Mimic call failed', call.id, call)
		}
		await sleep(pollIntervalMs)
	}
	throw new CallTimeoutError(`Mimic call timed out after ${timeoutMs}ms`, callId)
}

function validateToolsHaveCallbacks(tools: CreateAgentOptions['tools']) {
	if (!tools) return
	const missing = Object.entries(tools)
		.filter(([, tool]) => !tool.run)
		.map(([name]) => name)
	if (missing.length > 0) {
		throw new MimicError(
			`Tools [${missing.join(', ')}] are missing run() callbacks. Every custom tool must have a run function.`,
		)
	}
}

export async function runCall<T extends Record<string, unknown> = Record<string, unknown>>(
	client: MimicClient,
	options: CallOptions<T>,
	WebSocketImpl?: WebSocketConstructor,
): Promise<CallResult<T>> {
	validateToolsHaveCallbacks(options.tools)
	const agent = await client.createAgent(options)
	return runAgentCall<T>(client, agent, options, options, WebSocketImpl)
}

export async function runAgentCall<T extends Record<string, unknown> = Record<string, unknown>>(
	client: MimicClient,
	agent: Pick<ApiAgent, 'id'>,
	agentOptions: Pick<CreateAgentOptions, 'tools'>,
	options: AgentCallOptions,
	WebSocketImpl?: WebSocketConstructor,
): Promise<CallResult<T>> {
	validateToolsHaveCallbacks(agentOptions.tools)
	const call = await client.createCall({
		agentId: agent.id,
		to: options.to,
		context: options.context,
		idempotencyKey: options.idempotencyKey,
	})
	const toolConnection = connectToolCallbacks({
		url: client.toolSocketUrl(call.id),
		tools: agentOptions.tools,
		WebSocketImpl,
	})
	try {
		if (toolConnection) await toolConnection.ready
		return await pollCall<T>(client, call.id, options)
	} finally {
		toolConnection?.close()
	}
}
