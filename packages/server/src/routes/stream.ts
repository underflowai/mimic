import { eq } from 'drizzle-orm'

import { subscribeToCall, registerToolHandler, type ToolHandler } from '../call-runner.js'
import { verifyApiKey } from '../auth.js'
import { getDb } from '../db/index.js'
import { apiKeys } from '../db/schema.js'

async function authenticateToken(token: string): Promise<boolean> {
	if (!token) return false
	const db = getDb()
	const rows = await db.select().from(apiKeys).where(eq(apiKeys.status, 'active'))
	return rows.some((row) => verifyApiKey(token, row.keyHash))
}

export function handleStreamUpgrade(callId: string, token: string) {
	let toolHandler: ToolHandler | null = null
	let unsubscribe: (() => void) | null = null

	return {
		async onOpen(_event: unknown, ws: { send: (data: string) => void; close: () => void }) {
			const valid = await authenticateToken(token)
			if (!valid) {
				ws.send(JSON.stringify({ type: 'error', message: 'Invalid or missing API key' }))
				ws.close()
				return
			}

			unsubscribe = subscribeToCall(callId, (event) => {
				try {
					ws.send(JSON.stringify(event))
				} catch {}
			})

			toolHandler = registerToolHandler(callId, async (toolName, toolArgs, callbackId) => {
				return new Promise((resolve) => {
					const timeout = setTimeout(() => resolve({ error: `Tool "${toolName}" timed out waiting for SDK response` }), 30_000)

					ws.send(JSON.stringify({
						type: 'tool_call',
						callbackId,
						toolName,
						toolArgs,
					}))

					pendingToolCalls.set(callbackId, (result) => {
						clearTimeout(timeout)
						resolve(result)
					})
				})
			})
		},

		onMessage(event: { data: unknown }, _ws: unknown) {
			try {
				const msg = JSON.parse(String(event.data)) as {
					type?: string
					callbackId?: string
					result?: string
					error?: string
				}
				if (!msg.type || !msg.callbackId) return

				const handler = pendingToolCalls.get(msg.callbackId)
				if (!handler) return
				pendingToolCalls.delete(msg.callbackId)

				if (msg.type === 'tool_result' && typeof msg.result === 'string') {
					handler({ result: msg.result })
				} else if (msg.type === 'tool_error' && typeof msg.error === 'string') {
					handler({ error: msg.error })
				}
			} catch {}
		},

		onClose(_event: unknown, _ws: unknown) {
			unsubscribe?.()
			toolHandler?.unregister()
		},
	}
}

const pendingToolCalls = new Map<string, (result: { result: string } | { error: string }) => void>()
