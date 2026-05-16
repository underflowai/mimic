import type { MimicTool } from './types.js'

export interface ToolCallbackConnection {
	ready: Promise<void>
	close: () => void
}

export type WebSocketConstructor = typeof WebSocket

function normalizeToolResult(result: unknown) {
	if (typeof result === 'string') return result
	return JSON.stringify(result)
}

export function connectToolCallbacks(params: {
	url: string
	tools: Record<string, MimicTool> | undefined
	WebSocketImpl?: WebSocketConstructor
}): ToolCallbackConnection | null {
	const runnableTools = Object.fromEntries(Object.entries(params.tools ?? {}).filter(([, tool]) => tool.run))
	if (Object.keys(runnableTools).length === 0) return null

	const WebSocketImpl = params.WebSocketImpl ?? WebSocket
	const socket = new WebSocketImpl(params.url)
	const ready = new Promise<void>((resolve, reject) => {
		socket.addEventListener('open', () => resolve(), { once: true })
		socket.addEventListener('error', () => reject(new Error('tool callback socket failed to connect')), { once: true })
	})

	socket.addEventListener('message', (event) => {
		void handleToolSocketMessage(socket, runnableTools, String(event.data))
	})

	return {
		ready,
		close() {
			if (socket.readyState === WebSocketImpl.OPEN || socket.readyState === WebSocketImpl.CONNECTING) socket.close()
		},
	}
}

export async function handleToolSocketMessage(
	socket: Pick<WebSocket, 'send'>,
	tools: Record<string, MimicTool>,
	raw: string,
) {
	let parsed: { type?: unknown; callbackId?: unknown; toolName?: unknown; toolArgs?: unknown }
	try {
		parsed = JSON.parse(raw)
	} catch {
		return
	}
	if (parsed.type !== 'tool_call' || typeof parsed.callbackId !== 'string' || typeof parsed.toolName !== 'string')
		return

	const tool = tools[parsed.toolName]
	if (!tool?.run) {
		socket.send(JSON.stringify({ type: 'tool_error', callbackId: parsed.callbackId, error: 'tool not registered' }))
		return
	}

	try {
		const result = await tool.run((parsed.toolArgs ?? {}) as Record<string, unknown>)
		socket.send(
			JSON.stringify({ type: 'tool_result', callbackId: parsed.callbackId, result: normalizeToolResult(result) }),
		)
	} catch (err) {
		socket.send(
			JSON.stringify({
				type: 'tool_error',
				callbackId: parsed.callbackId,
				error: err instanceof Error ? err.message : String(err),
			}),
		)
	}
}
