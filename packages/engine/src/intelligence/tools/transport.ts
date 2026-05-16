import { createLogger } from '#engine/logger.js'
import type { CallTurn } from '../../shared/prompt-turns.js'
import type { ToolDefinition } from './runner.js'
import type { WebSearcher } from './web-searcher.js'

const log = createLogger('mimic:tool-transport')

export type ToolTransportResult = { result: string } | { error: string }

export interface SdkToolExecutor {
	(params: { toolName: string; toolArgs: Record<string, unknown>; signal?: AbortSignal }): Promise<ToolTransportResult>
}

export interface ToolTransportDeps {
	getCallerDateTime: () => string | undefined
	tools: ToolDefinition[]
	webSearcher: WebSearcher
	executeSdkTool?: SdkToolExecutor
}

export interface ToolTransportExecuteParams {
	toolName: string
	toolArgs: Record<string, unknown>
	conversationTurns: CallTurn[]
	signal?: AbortSignal
}

export interface ToolTransport {
	execute(params: ToolTransportExecuteParams): Promise<ToolTransportResult>
}

async function executeWebSearch(deps: ToolTransportDeps, params: ToolTransportExecuteParams) {
	const query = typeof params.toolArgs.query === 'string' ? params.toolArgs.query : ''
	if (!query.trim()) return { error: 'webSearch requires query' } satisfies ToolTransportResult
	const result = await deps.webSearcher.search(query, params.conversationTurns, deps.getCallerDateTime(), params.signal)
	if (!result?.trim()) return { error: 'webSearch returned no result' } satisfies ToolTransportResult
	return { result } satisfies ToolTransportResult
}

async function executeSdkCallback(deps: ToolTransportDeps, params: ToolTransportExecuteParams) {
	if (!deps.executeSdkTool) return { error: 'no SDK tool executor configured' } satisfies ToolTransportResult

	const socketResult = await deps.executeSdkTool({
		toolName: params.toolName,
		toolArgs: params.toolArgs,
		signal: params.signal,
	})
	if ('error' in socketResult) return socketResult

	const result = socketResult.result.trim()
	if (!result) return { error: 'SDK tool returned empty result' } satisfies ToolTransportResult
	return { result } satisfies ToolTransportResult
}

export function createToolTransport(deps: ToolTransportDeps): ToolTransport {
	return {
		async execute(params) {
			if (params.toolName === 'webSearch') return executeWebSearch(deps, params)
			const result = await executeSdkCallback(deps, params)
			if ('error' in result) {
				log.error({ toolName: params.toolName, error: result.error }, 'tool execution failed')
			}
			return result
		},
	}
}
