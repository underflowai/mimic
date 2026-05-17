/**
 * Tool Supervisor (XState v5)
 *
 * Spawns a ToolInvocation actor per detected tool intent. Each invocation
 * owns its lifecycle (detecting -> awaiting_args -> executing -> ready).
 * The supervisor coordinates:
 *
 * - Spawning and stopping invocation actors
 * - Routing later caller turns to awaiting_args invocations
 * - Enforcing max concurrent invocations (3)
 * - Building snapshots for the control block
 * - Execution signature deduplication
 *
 * Parent notifications (to call-machine):
 *   tool_intent_resolved  — classifier determined tool need (or not)
 *   tool_awaiting_args    — invocation needs more caller input
 *   tool_result_ready     — invocation produced a result
 */

import { createLogger } from '#engine/logger.js'
import { fromCallback, sendParent, setup, type ActorRefFrom, type SnapshotFrom } from 'xstate'

import type { CallTurn } from '../../shared/prompt-turns.js'
import { invocationMachine, type ToolInvocationActor, type ToolInvocationContext } from './invocation-machine.js'
import type { ToolDefinition } from './runner.js'

const log = createLogger('mimic:tool-supervisor')
const maxConcurrentExecutingInvocations = 3

// ---------------------------------------------------------------------------
// Types shared with consumers
// ---------------------------------------------------------------------------

export interface ToolStateForControlBlock {
	pendingTools: string[]
	executingTools: string[]
	toolResults: Array<{ topic: string; result: string }>
	toolDefinitions: Array<{ name: string; description: string }>
}

// ---------------------------------------------------------------------------
// Supervisor context
// ---------------------------------------------------------------------------

export interface CompletedToolResult {
	toolName: string
	topic: string
	result: string
}

export interface ToolSupervisorContext {
	nextTaskId: number
	tools: ToolDefinition[]
	executedSignatures: string[]
	completedResults: CompletedToolResult[]
	pendingResults: CompletedToolResult[]
	activeDirectorNote: string | null
	activeClassifyByTask: Record<string, string>
	classifyAttemptByTask: Record<string, number>
}

export interface ToolSupervisorInput {
	tools: ToolDefinition[]
}

// ---------------------------------------------------------------------------
// Classifier worker input/output
// ---------------------------------------------------------------------------

export interface ClassifyAndExecuteInput {
	classifyId: string
	existingToolArgs?: Record<string, unknown>
	existingToolName?: string
	transcript: string
	turnId: number
	taskId: number
	recentTurns: CallTurn[]
}

export type ClassifyResultEvent = {
	type: 'CLASSIFY_RESULT'
	classifyId: string
	transcript: string
	taskId: number
	turnId: number
	needsTool: boolean
	query: string
	toolName: string | null
	toolArgs: Record<string, unknown> | null
	missingArgs: string[]
	directorNote: string | null
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ToolSupervisorEvent =
	| { type: 'DETECT_INTENT'; transcript: string; turnId: number; recentTurns: CallTurn[] }
	| { type: 'RESET' }
	| { type: 'CLEAR_CONSUMED_RESULTS' }
	| ClassifyResultEvent
	| { type: 'INVOCATION_READY'; taskId: number; turnId: number; toolName: string; query: string; result: string }
	| { type: 'INVOCATION_FAILED'; taskId: number; turnId: number; query: string; error: string }
	| {
			type: 'INVOCATION_AWAITING_ARGS'
			taskId: number
			turnId: number
			toolName: string
			directorNote: string | null
			missingArgs: string[]
	  }
	| { type: 'INVOCATION_SUPERSEDED'; taskId: number; turnId: number }

// ---------------------------------------------------------------------------
// Parent-facing event types
// ---------------------------------------------------------------------------

export interface ToolResultReadyEvent {
	type: 'tool_result_ready'
	toolName: string
	result: string
}

export interface ToolIntentResolvedEvent {
	type: 'tool_intent_resolved'
	turnId: number
	needsTool: boolean
}

export interface ToolAwaitingArgsEvent {
	type: 'tool_awaiting_args'
	turnId: number
	taskId: number
	toolName: string
	directorNote: string | null
	missingArgs: string[]
}

export type ToolSupervisorParentEvent = ToolResultReadyEvent | ToolIntentResolvedEvent | ToolAwaitingArgsEvent

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInvocationRefs(children: Record<string, unknown>): ToolInvocationActor[] {
	return Object.entries(children)
		.filter(([key]) => key.startsWith('tool-'))
		.map(([, ref]) => ref as ToolInvocationActor)
}

function getInvocationContext(ref: ToolInvocationActor): ToolInvocationContext {
	return ref.getSnapshot().context
}

function getInvocationState(ref: ToolInvocationActor): string {
	return String(ref.getSnapshot().value)
}

function findInvocationByTaskId(children: Record<string, unknown>, taskId: number) {
	return getInvocationRefs(children).find((ref) => getInvocationContext(ref).taskId === taskId)
}

function findOldestAwaitingArgsInvocation(children: Record<string, unknown>) {
	return getInvocationRefs(children)
		.filter((ref) => getInvocationState(ref) === 'awaiting_args')
		.sort((a, b) => getInvocationContext(a).createdAt - getInvocationContext(b).createdAt)[0]
}

function findEquivalentInvocation(children: Record<string, unknown>, event: ClassifyResultEvent) {
	return getInvocationRefs(children).find((ref) => {
		const ctx = getInvocationContext(ref)
		const state = getInvocationState(ref)
		if (ctx.taskId === event.taskId) return false
		if (state === 'superseded' || state === 'failed') return false
		return ctx.query === event.query || ctx.originatingTranscript === event.transcript
	})
}

function stableSerialize(value: unknown): string {
	if (value === null || value === undefined) return 'null'
	if (typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(',')}}`
}

function executionSignature(toolName: string, args: Record<string, unknown>) {
	return `${toolName}:${stableSerialize(args)}`
}

function taskKey(taskId: number) {
	return String(taskId)
}

function setTaskMapEntry<T>(map: Record<string, T>, taskId: number, value: T): Record<string, T> {
	return { ...map, [taskKey(taskId)]: value }
}

function removeTaskMapEntry<T>(map: Record<string, T>, taskId: number): Record<string, T> {
	const next = { ...map }
	delete next[taskKey(taskId)]
	return next
}

function supersedeOverflowExecuting(children: Record<string, unknown>, currentTaskId: number) {
	const executing = getInvocationRefs(children)
		.filter((ref) => {
			const ctx = getInvocationContext(ref)
			return ctx.taskId !== currentTaskId && getInvocationState(ref) === 'executing'
		})
		.sort((a, b) => getInvocationContext(a).createdAt - getInvocationContext(b).createdAt)
	if (executing.length < maxConcurrentExecutingInvocations) return
	for (const ref of executing.slice(0, executing.length - (maxConcurrentExecutingInvocations - 1))) {
		const ctx = getInvocationContext(ref)
		log.info({ taskId: ctx.taskId, query: ctx.query }, 'superseding oldest executing tool invocation')
		ref.send({ type: 'SUPERSEDE' })
	}
}

// ---------------------------------------------------------------------------
// Snapshot helpers (external consumers read these)
// ---------------------------------------------------------------------------

export function getToolStateForControlBlock(snapshot: ToolSupervisorSnapshot): ToolStateForControlBlock {
	const pendingTools: string[] = snapshot.context.activeDirectorNote ? [snapshot.context.activeDirectorNote] : []
	const toolResults: Array<{ topic: string; result: string }> = []

	for (const r of snapshot.context.pendingResults) {
		toolResults.push({ topic: r.topic, result: r.result })
	}

	const toolDefinitions = snapshot.context.tools.map((t) => ({ name: t.name, description: t.description }))
	return { pendingTools, executingTools: [], toolResults, toolDefinitions }
}

/**
 * Mark pending results as consumed so they stop being injected into
 * the control block. Called after the director has committed a turn
 * that included the tool results.
 */
export function clearConsumedToolResults(actor: ToolSupervisorActor) {
	actor.send({ type: 'CLEAR_CONSUMED_RESULTS' })
}

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

export const toolSupervisorSetup = setup({
	types: {
		context: {} as ToolSupervisorContext,
		events: {} as ToolSupervisorEvent,
		input: {} as ToolSupervisorInput,
	},
	actors: {
		classifyAndExecute: fromCallback<ClassifyResultEvent, ClassifyAndExecuteInput>(() => {}),
		toolInvocation: invocationMachine,
	},
})

export const toolSupervisor = toolSupervisorSetup.createMachine({
	id: 'tool-supervisor',
	initial: 'active',
	context: ({ input }) => ({
		nextTaskId: 0,
		tools: input?.tools ?? [],
		executedSignatures: [],
		completedResults: [],
		pendingResults: [],
		activeDirectorNote: null,
		activeClassifyByTask: {},
		classifyAttemptByTask: {},
	}),
	states: {
		active: {
			on: {
				DETECT_INTENT: {
					actions: toolSupervisorSetup.enqueueActions(({ context, event, enqueue, self }) => {
						if (event.type !== 'DETECT_INTENT') return
						if (!event.transcript.trim()) return
						const children = self.getSnapshot().children
						const awaitingRef = findOldestAwaitingArgsInvocation(children)
						if (awaitingRef) {
							const awaiting = getInvocationContext(awaitingRef)
							const taskId = awaiting.taskId
							const taskClassifyKey = taskKey(taskId)
							const nextAttempt = (context.classifyAttemptByTask[taskClassifyKey] ?? 0) + 1
							const classifyId = `classify-${taskId}-${nextAttempt}`
							const priorClassifyId = context.activeClassifyByTask[taskClassifyKey]
							log.info({ taskId: awaiting.taskId, toolName: awaiting.toolName }, 'routing to awaiting invocation')
							if (priorClassifyId) enqueue.stopChild(priorClassifyId)
							enqueue.assign({
								classifyAttemptByTask: setTaskMapEntry(context.classifyAttemptByTask, taskId, nextAttempt),
								activeClassifyByTask: setTaskMapEntry(context.activeClassifyByTask, taskId, classifyId),
							})
							enqueue.spawnChild('classifyAndExecute', {
								id: classifyId,
								input: {
									classifyId,
									existingToolArgs: awaiting.toolArgs,
									existingToolName: awaiting.toolName,
									transcript: event.transcript,
									turnId: event.turnId,
									taskId,
									recentTurns: event.recentTurns,
								},
							})
							return
						}

						const taskId = context.nextTaskId
						const nextAttempt = 1
						const classifyId = `classify-${taskId}-${nextAttempt}`
						enqueue.assign({ nextTaskId: context.nextTaskId + 1 })
						enqueue.assign({
							classifyAttemptByTask: setTaskMapEntry(context.classifyAttemptByTask, taskId, nextAttempt),
							activeClassifyByTask: setTaskMapEntry(context.activeClassifyByTask, taskId, classifyId),
						})

						enqueue.spawnChild('toolInvocation', {
							id: `tool-${taskId}`,
							input: {
								taskId,
								turnId: event.turnId,
								transcript: event.transcript,
								conversationTurns: event.recentTurns,
								tools: context.tools,
							},
						})

						enqueue.spawnChild('classifyAndExecute', {
							id: classifyId,
							input: {
								classifyId,
								transcript: event.transcript,
								turnId: event.turnId,
								taskId,
								recentTurns: event.recentTurns,
							},
						})
					}),
				},

				CLASSIFY_RESULT: {
					actions: toolSupervisorSetup.enqueueActions(({ context, event, enqueue, self }) => {
						if (event.type !== 'CLASSIFY_RESULT') return
						const taskClassifyKey = taskKey(event.taskId)
						const activeClassifyId = context.activeClassifyByTask[taskClassifyKey]
						enqueue.stopChild(event.classifyId)
						if (activeClassifyId !== event.classifyId) {
							// Stale classify result (superseded by newer transcript for this task).
							return
						}
						enqueue.assign({
							activeClassifyByTask: removeTaskMapEntry(context.activeClassifyByTask, event.taskId),
						})
						enqueue.assign({ activeDirectorNote: event.directorNote })
						const ref = findInvocationByTaskId(self.getSnapshot().children, event.taskId)
						if (!ref) {
							log.error({ taskId: event.taskId }, 'CLASSIFY_RESULT for unknown invocation')
							if (!event.needsTool) {
								enqueue(
									sendParent({
										type: 'tool_intent_resolved' as const,
										turnId: event.turnId,
										needsTool: false,
									}),
								)
							}
							return
						}
						const state = getInvocationState(ref)
						const ctx = getInvocationContext(ref)
						if (!event.needsTool || !event.toolName) {
							if (state === 'detecting') {
								ref.send({
									type: 'CLASSIFY_RESULT',
									needsTool: false,
									query: event.query,
									toolName: null,
									toolArgs: null,
									missingArgs: [],
									directorNote: null,
								})
							}
							enqueue(
								sendParent({
									type: 'tool_intent_resolved' as const,
									turnId: event.turnId,
									needsTool: false,
								}),
							)
							return
						}

						// Check execution signature deduplication
						const sig = executionSignature(event.toolName, event.toolArgs ?? {})
						if (event.missingArgs.length === 0 && context.executedSignatures.includes(sig)) {
							log.info({ toolName: event.toolName, sig }, 'dedup: skipping already-executed tool signature')
							if (state === 'detecting') {
								ref.send({
									type: 'CLASSIFY_RESULT',
									needsTool: false,
									query: event.query,
									toolName: null,
									toolArgs: null,
									missingArgs: [],
									directorNote: null,
								})
							}
							enqueue(
								sendParent({
									type: 'tool_intent_resolved' as const,
									turnId: event.turnId,
									needsTool: true,
								}),
							)
							return
						}

						if (state === 'awaiting_args') {
							if (ctx.toolName !== event.toolName) {
								log.info(
									{ taskId: ctx.taskId, awaitingToolName: ctx.toolName, detectedToolName: event.toolName },
									'tool intent did not match awaiting invocation; starting separate invocation',
								)
								const taskId = context.nextTaskId
								enqueue.assign({ nextTaskId: context.nextTaskId + 1 })
								const duplicate = findEquivalentInvocation(self.getSnapshot().children, event)
								if (duplicate) {
									enqueue(
										sendParent({
											type: 'tool_intent_resolved' as const,
											turnId: event.turnId,
											needsTool: true,
										}),
									)
									return
								}
								if (event.missingArgs.length === 0) supersedeOverflowExecuting(self.getSnapshot().children, taskId)
								enqueue.spawnChild('toolInvocation', {
									id: `tool-${taskId}`,
									input: {
										taskId,
										turnId: event.turnId,
										transcript: event.transcript,
										conversationTurns: [],
										tools: context.tools,
									},
								})
								enqueue.sendTo(`tool-${taskId}`, {
									type: 'CLASSIFY_RESULT',
									needsTool: event.needsTool,
									query: event.query,
									toolName: event.toolName,
									toolArgs: event.toolArgs,
									missingArgs: event.missingArgs,
									directorNote: event.directorNote,
								})
								enqueue(
									sendParent({
										type: 'tool_intent_resolved' as const,
										turnId: event.turnId,
										needsTool: true,
									}),
								)
								return
							}
							ref.send({
								type: 'ARGS_UPDATED',
								turnId: event.turnId,
								query: event.query,
								toolArgs: event.toolArgs ?? {},
								missingArgs: event.missingArgs,
								directorNote: event.directorNote,
							})
							if (event.missingArgs.length === 0) {
								enqueue(
									sendParent({
										type: 'tool_intent_resolved' as const,
										turnId: event.turnId,
										needsTool: true,
									}),
								)
							}
							return
						}
						const duplicate = findEquivalentInvocation(self.getSnapshot().children, event)
						if (duplicate) {
							log.info(
								{ taskId: event.taskId, duplicateTaskId: getInvocationContext(duplicate).taskId },
								'deduping tool invocation',
							)
							ref.send({ type: 'SUPERSEDE' })
							enqueue(
								sendParent({
									type: 'tool_intent_resolved' as const,
									turnId: event.turnId,
									needsTool: true,
								}),
							)
							return
						}
						if (event.missingArgs.length === 0) supersedeOverflowExecuting(self.getSnapshot().children, event.taskId)
						ref.send({
							type: 'CLASSIFY_RESULT',
							needsTool: event.needsTool,
							query: event.query,
							toolName: event.toolName,
							toolArgs: event.toolArgs,
							missingArgs: event.missingArgs,
							directorNote: event.directorNote,
						})
						if (event.missingArgs.length === 0) {
							// Record the execution signature for dedup
							enqueue.assign({
								executedSignatures: [...context.executedSignatures, sig],
							})
							enqueue(
								sendParent({
									type: 'tool_intent_resolved' as const,
									turnId: event.turnId,
									needsTool: true,
								}),
							)
						}
					}),
				},

				INVOCATION_READY: {
					actions: toolSupervisorSetup.enqueueActions(({ context, event, enqueue }) => {
						if (event.type !== 'INVOCATION_READY') return
						enqueue.assign({ activeDirectorNote: null })
						const entry = { toolName: event.toolName, topic: event.toolName, result: event.result }
						enqueue.assign({
							completedResults: [...context.completedResults, entry],
							pendingResults: [...context.pendingResults, entry],
						})
						enqueue(
							sendParent({
								type: 'tool_result_ready' as const,
								toolName: event.toolName,
								result: event.result,
							}),
						)
					}),
				},

				INVOCATION_FAILED: {
					actions: toolSupervisorSetup.enqueueActions(({ context, event, enqueue }) => {
						if (event.type !== 'INVOCATION_FAILED') return
						enqueue.assign({ activeDirectorNote: null })
						enqueue.assign({
							activeClassifyByTask: removeTaskMapEntry(context.activeClassifyByTask, event.taskId),
						})
						enqueue.stopChild(`tool-${event.taskId}`)
					}),
				},
				INVOCATION_AWAITING_ARGS: {
					actions: sendParent(({ event }) =>
						event.type === 'INVOCATION_AWAITING_ARGS'
							? ({
									type: 'tool_awaiting_args' as const,
									turnId: event.turnId,
									taskId: event.taskId,
									toolName: event.toolName,
									directorNote: event.directorNote,
									missingArgs: event.missingArgs,
								} satisfies ToolAwaitingArgsEvent)
							: ({
									type: 'tool_awaiting_args' as const,
									turnId: 0,
									taskId: 0,
									toolName: '',
									directorNote: null,
									missingArgs: [],
								} satisfies ToolAwaitingArgsEvent),
					),
				},

				INVOCATION_SUPERSEDED: {
					actions: toolSupervisorSetup.enqueueActions(({ context, event, enqueue }) => {
						if (event.type !== 'INVOCATION_SUPERSEDED') return
						enqueue.assign({ activeDirectorNote: null })
						enqueue.assign({
							activeClassifyByTask: removeTaskMapEntry(context.activeClassifyByTask, event.taskId),
						})
						enqueue.stopChild(`tool-${event.taskId}`)
					}),
				},

				CLEAR_CONSUMED_RESULTS: {
					actions: toolSupervisorSetup.assign({ pendingResults: [] }),
				},

				RESET: {
					actions: toolSupervisorSetup.enqueueActions(({ self, enqueue }) => {
						const refs = getInvocationRefs(self.getSnapshot().children)
						for (const ref of refs) {
							const state = getInvocationState(ref)
							if (state !== 'superseded' && state !== 'failed') {
								ref.send({ type: 'SUPERSEDE' })
							}
						}
						enqueue.assign({
							activeDirectorNote: null,
							pendingResults: [],
							executedSignatures: [],
							activeClassifyByTask: {},
							classifyAttemptByTask: {},
						})
					}),
				},
			},
		},
	},
})

export type ToolSupervisorMachine = typeof toolSupervisor
export type ToolSupervisorActor = ActorRefFrom<ToolSupervisorMachine>
export type ToolSupervisorSnapshot = SnapshotFrom<ToolSupervisorMachine>
