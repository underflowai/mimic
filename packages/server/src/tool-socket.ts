import { randomUUID } from 'node:crypto'

import { Redis } from 'ioredis'

const channelPrefix = 'voice-api-tool'
const connectedTtlSeconds = 30
const refreshIntervalMs = 10_000
const defaultToolTimeoutMs = 15_000

let _redis: Redis | null = null

function getRedis(): Redis {
	if (!_redis) {
		const url = process.env.REDIS_URL
		if (!url) throw new Error('REDIS_URL environment variable is required')
		_redis = new Redis(url, { lazyConnect: true })
		_redis.on('error', (err) => console.error('[redis] connection error:', err.message))
	}
	return _redis
}

export interface ToolSocketCallRequest {
	type: 'tool_call'
	callbackId: string
	toolName: string
	toolArgs: Record<string, unknown>
}

export interface ToolSocketCallResult {
	type: 'tool_result'
	callbackId: string
	result: string
}

export interface ToolSocketCallError {
	type: 'tool_error'
	callbackId: string
	error: string
}

type ToolSocketClientMessage = ToolSocketCallResult | ToolSocketCallError

function requestChannel(callId: string) {
	return `${channelPrefix}:requests:${callId}`
}

function responseChannel(callId: string, callbackId: string) {
	return `${channelPrefix}:responses:${callId}:${callbackId}`
}

function presenceKey(callId: string) {
	return `${channelPrefix}:connected:${callId}`
}

function safeParseClientMessage(raw: string): ToolSocketClientMessage | null {
	try {
		const parsed = JSON.parse(raw) as Partial<ToolSocketClientMessage>
		if (parsed.type === 'tool_result' && typeof parsed.callbackId === 'string' && typeof parsed.result === 'string') {
			return parsed as ToolSocketCallResult
		}
		if (parsed.type === 'tool_error' && typeof parsed.callbackId === 'string' && typeof parsed.error === 'string') {
			return parsed as ToolSocketCallError
		}
		console.warn('[tool-socket] invalid message shape:', raw.slice(0, 200))
		return null
	} catch {
		console.warn('[tool-socket] invalid JSON:', raw.slice(0, 200))
		return null
	}
}

export function createToolSocketBridge(params: {
	callId: string
	send: (message: string) => void
	onError?: (err: unknown) => void
}) {
	const redis = getRedis()
	const subscriber = redis.duplicate()
	let closed = false

	async function refreshPresence() {
		if (closed) return
		await redis.set(presenceKey(params.callId), '1', 'EX', connectedTtlSeconds)
	}

	const refresh = setInterval(() => {
		refreshPresence().catch((err) => params.onError?.(err))
	}, refreshIntervalMs)

	subscriber.on('message', (_channel, raw) => {
		if (closed) return
		params.send(raw)
	})

	const ready = (async () => {
		await refreshPresence()
		await subscriber.subscribe(requestChannel(params.callId))
	})()

	async function handleMessage(raw: string) {
		const parsed = safeParseClientMessage(raw)
		if (!parsed) return
		await redis.publish(responseChannel(params.callId, parsed.callbackId), JSON.stringify(parsed))
	}

	async function close() {
		if (closed) return
		closed = true
		clearInterval(refresh)
		await redis.del(presenceKey(params.callId)).catch(() => {})
		await subscriber.unsubscribe(requestChannel(params.callId)).catch(() => {})
		await subscriber.quit().catch(() => {})
	}

	return { ready, handleMessage, close }
}

export async function requestToolExecutionOverSocket(params: {
	callId: string
	toolName: string
	toolArgs: Record<string, unknown>
	timeoutMs?: number
	signal?: AbortSignal
}): Promise<{ result: string } | { error: string }> {
	if (params.signal?.aborted) return { error: 'aborted' }
	const redis = getRedis()
	const connected = await redis.exists(presenceKey(params.callId))
	if (!connected) return { error: 'no SDK callback connected' }

	const callbackId = randomUUID()
	const subscriber = redis.duplicate()
	const responses = responseChannel(params.callId, callbackId)
	const timeoutMs = params.timeoutMs ?? defaultToolTimeoutMs

	return await new Promise((resolve) => {
		let settled = false
		let abortListener: (() => void) | null = null
		const settle = (value: { result: string } | { error: string }) => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			if (abortListener) params.signal?.removeEventListener('abort', abortListener)
			subscriber.unsubscribe(responses).catch(() => {})
			subscriber.quit().catch(() => {})
			resolve(value)
		}

		const timeout = setTimeout(() => settle({ error: `tool callback timed out after ${timeoutMs}ms` }), timeoutMs)
		abortListener = () => settle({ error: 'aborted' })
		params.signal?.addEventListener('abort', abortListener)

		subscriber.on('message', (_channel, raw) => {
			const parsed = safeParseClientMessage(raw)
			if (!parsed || parsed.callbackId !== callbackId) return
			if (parsed.type === 'tool_result') settle({ result: parsed.result })
			else settle({ error: parsed.error })
		})

		subscriber
			.subscribe(responses)
			.then(() =>
				redis.publish(
					requestChannel(params.callId),
					JSON.stringify({
						type: 'tool_call',
						callbackId,
						toolName: params.toolName,
						toolArgs: params.toolArgs,
					} satisfies ToolSocketCallRequest),
				),
			)
			.catch((err) => settle({ error: err instanceof Error ? err.message : String(err) }))
	})
}
