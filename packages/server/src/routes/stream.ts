import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'

import { registerToolHandler, subscribeToCall, type ToolHandler } from '../call-runner.js'
import { keyPrefixFor, verifyApiKey } from '../auth.js'
import { getDb } from '../db/index.js'
import { apiCalls, apiKeys, type ApiKeyRow } from '../db/schema.js'

const authTimeoutMs = 10_000
const toolCallbackTimeoutMs = 30_000

interface ToolCallbackResolution {
	connectionId: string
	resolve: (result: { result: string } | { error: string }) => void
	timeout: ReturnType<typeof setTimeout>
}

async function authenticateToken(token: string): Promise<ApiKeyRow | null> {
	if (!token) return null
	const db = getDb()
	const prefix = keyPrefixFor(token)
	const rows = await db
		.select()
		.from(apiKeys)
		.where(and(eq(apiKeys.status, 'active'), eq(apiKeys.keyPrefix, prefix)))
	return rows.find((row) => verifyApiKey(token, row.keyHash)) ?? null
}

async function getAuthorizedCallStatus(callId: string, apiKeyId: string) {
	const db = getDb()
	const [call] = await db
		.select({ status: apiCalls.status })
		.from(apiCalls)
		.where(and(eq(apiCalls.id, callId), eq(apiCalls.apiKeyId, apiKeyId)))
		.limit(1)
	return call?.status ?? null
}

function flushPendingCallsForConnection(connectionId: string, reason: string) {
	for (const [callbackId, pending] of pendingToolCalls.entries()) {
		if (pending.connectionId !== connectionId) continue
		pendingToolCalls.delete(callbackId)
		clearTimeout(pending.timeout)
		pending.resolve({ error: reason })
	}
}

export function handleStreamUpgrade(callId: string) {
	let toolHandler: ToolHandler | null = null
	let unsubscribe: (() => void) | null = null
	let wsRef: { send: (data: string) => void; close: () => void } | null = null
	let authenticated = false
	let authTimeout: ReturnType<typeof setTimeout> | null = null
	const connectionId = randomUUID()

	async function authenticateAndBind(token: string) {
		if (authenticated) return
		const ws = wsRef
		if (!ws) return
		if (!callId.trim()) {
			ws.send(JSON.stringify({ type: 'error', message: 'Missing call id' }))
			ws.close()
			return
		}

		const apiKey = await authenticateToken(token)
		if (!apiKey) {
			ws.send(JSON.stringify({ type: 'error', message: 'Invalid or missing API key' }))
			ws.close()
			return
		}

		const status = await getAuthorizedCallStatus(callId, apiKey.id)
		if (!status) {
			ws.send(JSON.stringify({ type: 'error', message: 'Call not found or unauthorized' }))
			ws.close()
			return
		}

		unsubscribe = subscribeToCall(callId, (event) => {
			try {
				ws.send(JSON.stringify(event))
			} catch {}
		})

		toolHandler = registerToolHandler(
			callId,
			async (toolName, toolArgs, callbackId) => {
				return new Promise((resolve) => {
					const socket = wsRef
					if (!socket) {
						resolve({ error: `Tool "${toolName}" failed because SDK disconnected` })
						return
					}

					const timeout = setTimeout(() => {
						pendingToolCalls.delete(callbackId)
						resolve({ error: `Tool "${toolName}" timed out waiting for SDK response` })
					}, toolCallbackTimeoutMs)

					pendingToolCalls.set(callbackId, { connectionId, resolve, timeout })

					try {
						socket.send(JSON.stringify({
							type: 'tool_call',
							callbackId,
							toolName,
							toolArgs,
						}))
					} catch {
						pendingToolCalls.delete(callbackId)
						clearTimeout(timeout)
						resolve({ error: `Tool "${toolName}" failed to send request to SDK` })
					}
				})
			},
			connectionId,
		)

		if (!toolHandler.registered) {
			unsubscribe?.()
			unsubscribe = null
			ws.send(JSON.stringify({ type: 'error', message: 'Another SDK connection already owns this call tool channel' }))
			ws.close()
			return
		}

		authenticated = true
		if (authTimeout) {
			clearTimeout(authTimeout)
			authTimeout = null
		}
		ws.send(JSON.stringify({ type: 'call_status', status }))
	}

	return {
		async onOpen(_event: unknown, ws: { send: (data: string) => void; close: () => void }) {
			wsRef = ws
			authTimeout = setTimeout(() => {
				if (authenticated) return
				ws.send(JSON.stringify({ type: 'error', message: 'WebSocket auth timeout' }))
				ws.close()
			}, authTimeoutMs)
		},

		onMessage(event: { data: unknown }, _ws: unknown) {
			void (async () => {
				try {
					const msg = JSON.parse(String(event.data)) as {
						type?: string
						token?: string
						callbackId?: string
						result?: string
						error?: string
					}

					if (!authenticated) {
						if (msg.type === 'auth' && typeof msg.token === 'string') {
							await authenticateAndBind(msg.token)
							return
						}
						wsRef?.send(JSON.stringify({ type: 'error', message: 'Authenticate first with { type: "auth", token }' }))
						wsRef?.close()
						return
					}

					if (!msg.type || !msg.callbackId) return

					const pending = pendingToolCalls.get(msg.callbackId)
					if (!pending || pending.connectionId !== connectionId) return
					pendingToolCalls.delete(msg.callbackId)
					clearTimeout(pending.timeout)

					if (msg.type === 'tool_result' && typeof msg.result === 'string') {
						pending.resolve({ result: msg.result })
					} else if (msg.type === 'tool_error' && typeof msg.error === 'string') {
						pending.resolve({ error: msg.error })
					}
				} catch {}
			})()
		},

		onClose(_event: unknown, _ws: unknown) {
			if (authTimeout) {
				clearTimeout(authTimeout)
				authTimeout = null
			}
			flushPendingCallsForConnection(connectionId, 'SDK disconnected before tool response')
			unsubscribe?.()
			toolHandler?.unregister()
			wsRef = null
		},
	}
}

const pendingToolCalls = new Map<string, ToolCallbackResolution>()
