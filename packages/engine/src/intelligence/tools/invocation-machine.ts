/**
 * Tool Invocation Machine (XState v5)
 *
 * Per-tool lifecycle actor spawned by the supervisor. Each invocation
 * owns its lifecycle from detection through ready:
 *
 *   detecting -> awaiting_args -> executing -> ready
 *                                           \-> failed / superseded
 *
 * Ready is a terminal resting state — the result sits in context and is
 * surfaced via the supervisor's `getToolStateForControlBlock`. The agent
 * incorporates it naturally on the next turn.
 */

import { assign, fromPromise, sendParent, setup, type ActorRefFrom } from 'xstate'

import type { CallTurn } from '../../shared/prompt-turns.js'
import type { ToolDefinition } from './runner.js'
import type { ToolTransportResult } from './transport.js'

export interface ToolInvocationInput {
	taskId: number
	turnId: number
	transcript: string
	conversationTurns: CallTurn[]
	tools: ToolDefinition[]
}

export interface ToolInvocationContext {
	abort: AbortController
	conversationTurns: CallTurn[]
	createdAt: number
	directorNote: string | null
	missingArgs: string[]
	originatingTranscript: string
	query: string
	readyAt: number | null
	result: string | null
	taskId: number
	tool: ToolDefinition | null
	toolArgs: Record<string, unknown>
	toolName: string
	tools: ToolDefinition[]
	turnId: number
}

export type ToolInvocationEvent =
	| {
			type: 'CLASSIFY_RESULT'
			needsTool: boolean
			query: string
			toolName: string | null
			toolArgs: Record<string, unknown> | null
			missingArgs: string[]
			directorNote: string | null
	  }
	| {
			type: 'ARGS_UPDATED'
			turnId: number
			query: string
			toolArgs: Record<string, unknown>
			missingArgs: string[]
			directorNote: string | null
	  }
	| { type: 'SUPERSEDE' }
	| { type: 'ABORT' }

type ToolInvocationParentEvent =
	| {
			type: 'INVOCATION_AWAITING_ARGS'
			taskId: number
			turnId: number
			toolName: string
			directorNote: string | null
			missingArgs: string[]
	  }
	| { type: 'INVOCATION_READY'; taskId: number; turnId: number; toolName: string; query: string; result: string }
	| { type: 'INVOCATION_FAILED'; taskId: number; turnId: number; query: string; error: string }
	| { type: 'INVOCATION_SUPERSEDED'; taskId: number; turnId: number }

export interface ExecuteToolInput {
	toolName: string
	toolArgs: Record<string, unknown>
	conversationTurns: CallTurn[]
	signal: AbortSignal
}

function resolveTool(tools: ToolDefinition[], toolName: string): ToolDefinition | null {
	return tools.find((t) => t.name === toolName) ?? null
}

const executionTimeoutMs = 30_000

export const invocationMachineSetup = setup({
	types: {
		context: {} as ToolInvocationContext,
		events: {} as ToolInvocationEvent,
		input: {} as ToolInvocationInput,
		emitted: {} as ToolInvocationParentEvent,
	},
	actors: {
		executeTool: fromPromise<ToolTransportResult, ExecuteToolInput>(async () => ({
			error: 'executeTool actor not provided',
		})),
	},
	delays: {
		executionTimeoutMs,
	},
})

export const invocationMachine = invocationMachineSetup.createMachine({
	id: 'tool-invocation',
	initial: 'detecting',
	context: ({ input }) => ({
		abort: new AbortController(),
		conversationTurns: input.conversationTurns,
		createdAt: Date.now(),
		directorNote: null,
		missingArgs: [],
		originatingTranscript: input.transcript,
		query: input.transcript,
		readyAt: null,
		result: null,
		taskId: input.taskId,
		tool: null,
		toolArgs: {},
		toolName: '',
		tools: input.tools,
		turnId: input.turnId,
	}),
	on: {
		ABORT: {
			target: '.superseded',
			actions: ({ context }) => context.abort.abort(),
		},
		SUPERSEDE: {
			target: '.superseded',
			actions: ({ context }) => context.abort.abort(),
		},
	},
	states: {
		detecting: {
			on: {
				CLASSIFY_RESULT: [
					{
						guard: ({ event }) => !event.needsTool || !event.toolName,
						target: 'superseded',
					},
					{
						guard: ({ event }) => event.missingArgs.length > 0,
						target: 'awaiting_args',
						actions: assign({
							missingArgs: ({ event }) => [...event.missingArgs],
							directorNote: ({ event }) => event.directorNote,
							query: ({ event }) => event.query,
							toolArgs: ({ event }) => event.toolArgs ?? {},
							toolName: ({ event }) => event.toolName ?? '',
							tool: ({ context, event }) => resolveTool(context.tools, event.toolName!),
						}),
					},
					{
						target: 'executing',
						actions: assign({
							missingArgs: () => [],
							directorNote: ({ event }) => event.directorNote,
							query: ({ event }) => event.query,
							toolArgs: ({ event }) => event.toolArgs ?? {},
							toolName: ({ event }) => event.toolName ?? '',
							tool: ({ context, event }) => resolveTool(context.tools, event.toolName!),
						}),
					},
				],
			},
		},
		awaiting_args: {
			entry: sendParent(({ context }) => ({
				type: 'INVOCATION_AWAITING_ARGS' as const,
				taskId: context.taskId,
				turnId: context.turnId,
				toolName: context.toolName,
				directorNote: context.directorNote,
				missingArgs: context.missingArgs,
			})),
			on: {
				ARGS_UPDATED: [
					{
						guard: ({ event }) => event.missingArgs.length > 0,
						target: 'awaiting_args',
						reenter: true,
						actions: assign({
							missingArgs: ({ event }) => [...event.missingArgs],
							directorNote: ({ event }) => event.directorNote,
							query: ({ event }) => event.query,
							toolArgs: ({ context, event }) => ({ ...context.toolArgs, ...event.toolArgs }),
							turnId: ({ event }) => event.turnId,
						}),
					},
					{
						target: 'executing',
						actions: assign({
							missingArgs: () => [],
							directorNote: ({ event }) => event.directorNote,
							query: ({ event }) => event.query,
							toolArgs: ({ context, event }) => ({ ...context.toolArgs, ...event.toolArgs }),
							turnId: ({ event }) => event.turnId,
						}),
					},
				],
			},
		},
		executing: {
			after: {
				executionTimeoutMs: {
					target: 'failed',
					actions: ({ context }) => context.abort.abort(),
				},
			},
			invoke: {
				src: 'executeTool',
				input: ({ context }): ExecuteToolInput => ({
					toolName: context.toolName,
					toolArgs: context.toolArgs,
					conversationTurns: context.conversationTurns,
					signal: context.abort.signal,
				}),
				onDone: [
					{
						guard: ({ event }) => 'result' in event.output,
						target: 'ready',
						actions: assign({
							readyAt: () => Date.now(),
							result: ({ event }) => ('result' in event.output ? event.output.result : null),
						}),
					},
					{
						target: 'failed',
					},
				],
				onError: {
					target: 'failed',
				},
			},
		},
		ready: {
			entry: sendParent(({ context }) => ({
				type: 'INVOCATION_READY' as const,
				taskId: context.taskId,
				turnId: context.turnId,
				toolName: context.toolName,
				query: context.query,
				result: context.result ?? '',
			})),
		},
		failed: {
			type: 'final',
			entry: sendParent(({ context }) => ({
				type: 'INVOCATION_FAILED' as const,
				taskId: context.taskId,
				turnId: context.turnId,
				query: context.query,
				error: 'tool execution failed',
			})),
		},
		superseded: {
			type: 'final',
			entry: sendParent(({ context }) => ({
				type: 'INVOCATION_SUPERSEDED' as const,
				taskId: context.taskId,
				turnId: context.turnId,
			})),
		},
	},
})

export type ToolInvocationMachine = typeof invocationMachine
export type ToolInvocationActor = ActorRefFrom<ToolInvocationMachine>
