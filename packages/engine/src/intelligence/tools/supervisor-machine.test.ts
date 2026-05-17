import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createActor, fromCallback, fromPromise, sendTo, setup } from 'xstate'

import { invocationMachine, type ExecuteToolInput } from './invocation-machine.js'
import type { ToolDefinition } from './runner.js'
import {
	getToolStateForControlBlock,
	toolSupervisor,
	type ClassifyAndExecuteInput,
	type ClassifyResultEvent,
	type ToolSupervisorParentEvent,
	type ToolSupervisorSnapshot,
} from './supervisor-machine.js'
import type { ToolTransportResult } from './transport.js'

// ---------------------------------------------------------------------------
// Test tool definitions
// ---------------------------------------------------------------------------

const readTool: ToolDefinition = {
	name: 'checkCalendar',
	description: 'Check calendar availability',
	kind: 'read',
	parameters: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] },
}

const writeTool: ToolDefinition = {
	name: 'bookMeeting',
	description: 'Book a meeting',
	kind: 'write',
	parameters: {
		type: 'object',
		properties: { date: { type: 'string' }, time: { type: 'string' } },
		required: ['date', 'time'],
	},
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface ClassifySpec {
	needsTool: boolean
	query: string
	toolName: string | null
	toolArgs: Record<string, unknown> | null
	missingArgs: string[]
	directorNote?: string | null
}

interface HarnessOptions {
	tools?: ToolDefinition[]
	classifyResults: ClassifySpec[]
	classifyDelaysMs?: number[]
	executionResults?: ToolTransportResult[]
	transportDelay?: number
	executionTimeoutMs?: number
}

/**
 * Wraps the real toolSupervisor machine in a parent that:
 * 1. Provides stub classifyAndExecute / executeTool actors
 * 2. Forwards DETECT_INTENT / RESET to the supervisor
 * 3. Collects all sendParent events from the supervisor into parentEvents[]
 */
function createTestHarness(opts: HarnessOptions) {
	const parentEvents: ToolSupervisorParentEvent[] = []
	let classifyIdx = 0
	let executeIdx = 0
	const tools = opts.tools ?? [readTool, writeTool]

	const testInvocationMachine = invocationMachine.provide({
		actors: {
			executeTool: fromPromise<ToolTransportResult, ExecuteToolInput>(async () => {
				if (opts.transportDelay) await delay(opts.transportDelay)
				const result = opts.executionResults?.[executeIdx] ?? { result: 'ok' }
				executeIdx++
				return result
			}),
		},
		delays: {
			executionTimeoutMs: opts.executionTimeoutMs ?? 30_000,
		},
	})

	const testSupervisorMachine = toolSupervisor.provide({
		actors: {
			classifyAndExecute: fromCallback<ClassifyResultEvent, ClassifyAndExecuteInput>(({ sendBack, input }) => {
				const idx = classifyIdx
				const spec = opts.classifyResults[idx]
				classifyIdx++
				if (!spec) return
				const message: ClassifyResultEvent = {
					type: 'CLASSIFY_RESULT',
					classifyId: input.classifyId,
					transcript: input.transcript,
					taskId: input.taskId,
					turnId: input.turnId,
					needsTool: spec.needsTool,
					query: spec.query,
					toolName: spec.toolName,
					toolArgs: spec.toolArgs,
					missingArgs: spec.missingArgs,
					directorNote: spec.directorNote ?? null,
				}
				const delayMs = opts.classifyDelaysMs?.[idx] ?? 0
				if (delayMs <= 0) {
					sendBack(message)
					return
				}
				const timer = setTimeout(() => sendBack(message), delayMs)
				return () => clearTimeout(timer)
			}),
			toolInvocation: testInvocationMachine,
		},
	})

	const parentMachine = setup({
		types: {
			context: {} as { events: ToolSupervisorParentEvent[] },
			events: {} as
				| { type: 'DETECT_INTENT'; transcript: string; turnId: number }
				| { type: 'RESET' }
				| ToolSupervisorParentEvent,
		},
		actors: {
			supervisor: testSupervisorMachine,
		},
	}).createMachine({
		id: 'test-parent',
		initial: 'running',
		context: { events: parentEvents },
		invoke: {
			id: 'sup',
			src: 'supervisor',
			input: { tools },
		},
		states: {
			running: {
				on: {
					DETECT_INTENT: {
						actions: sendTo('sup', ({ event }) => ({
							type: 'DETECT_INTENT' as const,
							transcript: event.transcript,
							turnId: event.turnId,
							recentTurns: [],
						})),
					},
					RESET: {
						actions: sendTo('sup', { type: 'RESET' as const }),
					},
					tool_intent_resolved: {
						actions: ({ context, event }) => context.events.push(event as ToolSupervisorParentEvent),
					},
					tool_awaiting_args: {
						actions: ({ context, event }) => context.events.push(event as ToolSupervisorParentEvent),
					},
					tool_result_ready: {
						actions: ({ context, event }) => context.events.push(event as ToolSupervisorParentEvent),
					},
				},
			},
		},
	})

	const actor = createActor(parentMachine)
	actor.start()

	function getSupSnapshot(): ToolSupervisorSnapshot {
		const children = actor.getSnapshot().children as Record<string, { getSnapshot: () => ToolSupervisorSnapshot }>
		return children.sup.getSnapshot()
	}

	return { actor, parentEvents, getSupSnapshot }
}

// ---------------------------------------------------------------------------
// Invocation snapshot helpers (mirror internals for assertions)
// ---------------------------------------------------------------------------

type InvocationRef = { getSnapshot: () => { value: string; context: Record<string, unknown> } }

function getInvocationRefs(children: Record<string, unknown>): InvocationRef[] {
	return Object.entries(children)
		.filter(([key]) => key.startsWith('tool-'))
		.map(([, ref]) => ref as InvocationRef)
}

function invState(ref: InvocationRef) {
	return String(ref.getSnapshot().value)
}

function invCtx(ref: InvocationRef) {
	return ref.getSnapshot().context as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tool-supervisor-machine', () => {
	it('basic lifecycle: DETECT_INTENT -> classify(execute) -> executing -> ready -> tool_result_ready parent event', async () => {
		const { actor, parentEvents, getSupSnapshot } = createTestHarness({
			classifyResults: [
				{
					needsTool: true,
					query: 'check my calendar for tomorrow',
					toolName: 'checkCalendar',
					toolArgs: { date: '2026-05-10' },
					missingArgs: [],
				},
			],
			executionResults: [{ result: 'You have 3 meetings tomorrow' }],
		})

		actor.send({ type: 'DETECT_INTENT', transcript: 'check my calendar for tomorrow', turnId: 1 })
		await delay(50)

		const snap = getSupSnapshot()
		const refs = getInvocationRefs(snap.children)
		assert.equal(refs.length, 1)
		assert.equal(invState(refs[0]!), 'ready')
		assert.equal(invCtx(refs[0]!).result, 'You have 3 meetings tomorrow')

		const readyEvent = parentEvents.find((e) => e.type === 'tool_result_ready')
		assert.ok(readyEvent, 'should emit tool_result_ready to parent')
		assert.equal((readyEvent as { result: string }).result, 'You have 3 meetings tomorrow')

		actor.stop()
	})

	it('awaiting_args: classify returns not_ready with missing -> tool_awaiting_args parent event', async () => {
		const { actor, parentEvents, getSupSnapshot } = createTestHarness({
			classifyResults: [
				{
					needsTool: true,
					query: 'check my calendar',
					toolName: 'checkCalendar',
					toolArgs: {},
					missingArgs: ['date'],
				},
			],
		})

		actor.send({ type: 'DETECT_INTENT', transcript: 'check my calendar', turnId: 1 })
		await delay(50)

		const refs = getInvocationRefs(getSupSnapshot().children)
		assert.equal(refs.length, 1)
		assert.equal(invState(refs[0]!), 'awaiting_args')
		assert.deepEqual(invCtx(refs[0]!).missingArgs, ['date'])

		const awaitingEvent = parentEvents.find((e) => e.type === 'tool_awaiting_args')
		assert.ok(awaitingEvent, 'should emit tool_awaiting_args to parent')
		assert.equal((awaitingEvent as { toolName: string }).toolName, 'checkCalendar')
		assert.deepEqual((awaitingEvent as { missingArgs: string[] }).missingArgs, ['date'])

		actor.stop()
	})

	it('transcript routing: second DETECT_INTENT routes to awaiting_args invocation', async () => {
		const { actor, getSupSnapshot } = createTestHarness({
			classifyResults: [
				{
					needsTool: true,
					query: 'check my calendar',
					toolName: 'checkCalendar',
					toolArgs: {},
					missingArgs: ['date'],
				},
				{
					needsTool: true,
					query: 'check my calendar for Friday',
					toolName: 'checkCalendar',
					toolArgs: { date: '2026-05-15' },
					missingArgs: [],
				},
			],
			executionResults: [{ result: 'Friday is free' }],
		})

		actor.send({ type: 'DETECT_INTENT', transcript: 'check my calendar', turnId: 1 })
		await delay(50)

		let refs = getInvocationRefs(getSupSnapshot().children)
		assert.equal(refs.length, 1)
		assert.equal(invState(refs[0]!), 'awaiting_args')

		actor.send({ type: 'DETECT_INTENT', transcript: 'this Friday', turnId: 2 })
		await delay(50)

		refs = getInvocationRefs(getSupSnapshot().children)
		const active = refs.filter((r) => invState(r) !== 'superseded' && invState(r) !== 'failed')
		assert.equal(active.length, 1)
		assert.equal(invState(active[0]!), 'ready')
		assert.equal(invCtx(active[0]!).result, 'Friday is free')

		actor.stop()
	})

	it('awaiting_args classification is latest-wins per task', async () => {
		const { actor, getSupSnapshot } = createTestHarness({
			classifyResults: [
				{
					needsTool: true,
					query: 'check my calendar',
					toolName: 'checkCalendar',
					toolArgs: {},
					missingArgs: ['date'],
				},
				{
					needsTool: true,
					query: 'for friday',
					toolName: 'checkCalendar',
					toolArgs: { date: '2026-05-15' },
					missingArgs: [],
				},
				{
					needsTool: true,
					query: 'actually saturday',
					toolName: 'checkCalendar',
					toolArgs: { date: '2026-05-16' },
					missingArgs: [],
				},
			],
			classifyDelaysMs: [0, 120, 20],
			executionResults: [{ result: 'Saturday is free' }],
		})

		actor.send({ type: 'DETECT_INTENT', transcript: 'check my calendar', turnId: 1 })
		await delay(30)
		let refs = getInvocationRefs(getSupSnapshot().children)
		assert.equal(refs.length, 1)
		assert.equal(invState(refs[0]!), 'awaiting_args')

		actor.send({ type: 'DETECT_INTENT', transcript: 'for friday', turnId: 2 })
		await delay(5)
		actor.send({ type: 'DETECT_INTENT', transcript: 'actually saturday', turnId: 3 })
		await delay(80)

		refs = getInvocationRefs(getSupSnapshot().children)
		const active = refs.filter((r) => invState(r) !== 'superseded' && invState(r) !== 'failed')
		assert.equal(active.length, 1)
		assert.equal(invState(active[0]!), 'ready')
		assert.equal(invCtx(active[0]!).query, 'actually saturday')
		assert.deepEqual(invCtx(active[0]!).toolArgs, { date: '2026-05-16' })
		assert.equal(invCtx(active[0]!).result, 'Saturday is free')

		// Ensure late stale classifier result cannot overwrite the settled latest result.
		await delay(90)
		assert.equal(invCtx(active[0]!).query, 'actually saturday')
		assert.deepEqual(invCtx(active[0]!).toolArgs, { date: '2026-05-16' })

		actor.stop()
	})

	it('duplicate detection: same transcript supersedes instead of double-executing', async () => {
		const { actor, getSupSnapshot } = createTestHarness({
			classifyResults: [
				{
					needsTool: true,
					query: 'check my calendar',
					toolName: 'checkCalendar',
					toolArgs: { date: '2026-05-10' },
					missingArgs: [],
				},
				{
					needsTool: true,
					query: 'check my calendar',
					toolName: 'checkCalendar',
					toolArgs: { date: '2026-05-10' },
					missingArgs: [],
				},
			],
			executionResults: [{ result: 'Calendar data' }],
			transportDelay: 100,
		})

		actor.send({ type: 'DETECT_INTENT', transcript: 'check my calendar', turnId: 1 })
		await delay(10)
		actor.send({ type: 'DETECT_INTENT', transcript: 'check my calendar', turnId: 2 })
		await delay(200)

		const refs = getInvocationRefs(getSupSnapshot().children)
		const nonSuperseded = refs.filter((r) => invState(r) !== 'superseded')
		assert.ok(nonSuperseded.length <= 1, `expected at most 1 active invocation, got ${nonSuperseded.length}`)

		actor.stop()
	})

	it('max concurrent (3): oldest executing superseded on overflow', async () => {
		const classifyResults: ClassifySpec[] = []
		const executionResults: ToolTransportResult[] = []
		const uniqueQueries = [
			'what is on my calendar Monday',
			'check Tuesday schedule please',
			'show me Wednesday availability',
			'find Thursday open slots now',
		]
		for (let i = 0; i < 4; i++) {
			classifyResults.push({
				needsTool: true,
				query: uniqueQueries[i]!,
				toolName: 'checkCalendar',
				toolArgs: { date: `2026-06-${10 + i}` },
				missingArgs: [],
			})
			executionResults.push({ result: `result-${i}` })
		}

		const { actor, parentEvents, getSupSnapshot } = createTestHarness({
			classifyResults,
			executionResults,
			transportDelay: 500,
		})

		for (let i = 0; i < 4; i++) {
			actor.send({
				type: 'DETECT_INTENT',
				transcript: uniqueQueries[i]!,
				turnId: i + 1,
			})
			await delay(30)
		}
		await delay(100)

		// Superseded children get stopped/removed from children, so check
		// remaining executing count and parent events for the supersede signal.
		const refs = getInvocationRefs(getSupSnapshot().children)
		const executing = refs.filter((r) => invState(r) === 'executing')
		assert.ok(executing.length <= 3, `expected at most 3 executing, got ${executing.length}`)

		// 4 spawned, at most 3 remain → at least 1 was superseded and cleaned up
		assert.ok(refs.length <= 3, `expected at most 3 remaining children after overflow, got ${refs.length}`)
		// Verify via parent events: the supervisor forwarded tool_intent_resolved for all 4
		const resolvedEvents = parentEvents.filter((e) => e.type === 'tool_intent_resolved')
		assert.ok(
			resolvedEvents.length >= 4,
			`expected at least 4 tool_intent_resolved events, got ${resolvedEvents.length}`,
		)

		actor.stop()
	})

	it('write tool executes when required args are present without agent_confirmation gate', async () => {
		const { actor, parentEvents, getSupSnapshot } = createTestHarness({
			tools: [writeTool],
			classifyResults: [
				{
					needsTool: true,
					query: 'book a meeting tomorrow at 3pm',
					toolName: 'bookMeeting',
					toolArgs: { date: '2026-05-10', time: '3pm' },
					missingArgs: [],
				},
			],
		})

		actor.send({ type: 'DETECT_INTENT', transcript: 'book a meeting tomorrow at 3pm', turnId: 1 })
		await delay(50)

		const refs = getInvocationRefs(getSupSnapshot().children)
		assert.equal(refs.length, 1)
		assert.equal(invState(refs[0]!), 'ready')

		const awaitingEvent = parentEvents.find((e) => e.type === 'tool_awaiting_args')
		assert.equal(awaitingEvent, undefined)
		const readyEvent = parentEvents.find((e) => e.type === 'tool_result_ready')
		assert.ok(readyEvent)

		actor.stop()
	})

	it('execution timeout: invocation transitions to failed after timeout', async () => {
		const { actor, getSupSnapshot } = createTestHarness({
			classifyResults: [
				{
					needsTool: true,
					query: 'slow calendar check',
					toolName: 'checkCalendar',
					toolArgs: { date: '2026-05-10' },
					missingArgs: [],
				},
			],
			executionResults: [{ result: 'should not arrive' }],
			transportDelay: 500,
			executionTimeoutMs: 50,
		})

		actor.send({ type: 'DETECT_INTENT', transcript: 'slow calendar check', turnId: 1 })
		await delay(200)

		const refs = getInvocationRefs(getSupSnapshot().children)
		// After failed (final), supervisor stops the child — refs may be empty
		if (refs.length > 0) {
			assert.equal(invState(refs[0]!), 'failed')
		}

		actor.stop()
	})

	it('RESET supersedes all non-terminal children', async () => {
		const { actor, getSupSnapshot } = createTestHarness({
			classifyResults: [
				{
					needsTool: true,
					query: 'check calendar A',
					toolName: 'checkCalendar',
					toolArgs: { date: '2026-05-10' },
					missingArgs: [],
				},
				{
					needsTool: true,
					query: 'check calendar B',
					toolName: 'checkCalendar',
					toolArgs: {},
					missingArgs: ['date'],
				},
			],
			executionResults: [{ result: 'Result A' }],
			transportDelay: 100,
		})

		actor.send({ type: 'DETECT_INTENT', transcript: 'check calendar A', turnId: 1 })
		await delay(10)
		actor.send({ type: 'DETECT_INTENT', transcript: 'check calendar B', turnId: 2 })
		await delay(20)

		actor.send({ type: 'RESET' })
		await delay(50)

		const refs = getInvocationRefs(getSupSnapshot().children)
		for (const ref of refs) {
			const state = invState(ref)
			assert.ok(state === 'superseded' || state === 'failed', `expected terminal state, got ${state}`)
		}

		actor.stop()
	})

	it('getToolStateForControlBlock returns structured state snapshot', async () => {
		const { actor, getSupSnapshot } = createTestHarness({
			classifyResults: [
				{
					needsTool: true,
					query: 'check availability',
					toolName: 'checkCalendar',
					toolArgs: { date: '2026-05-10' },
					missingArgs: [],
				},
			],
			executionResults: [{ result: 'Free all day' }],
		})

		actor.send({ type: 'DETECT_INTENT', transcript: 'check availability', turnId: 1 })
		await delay(50)

		const toolState = getToolStateForControlBlock(getSupSnapshot())
		assert.equal(toolState.pendingTools.length, 0)
		assert.equal(toolState.executingTools.length, 0)
		assert.equal(toolState.toolResults.length, 1)
		assert.ok(toolState.toolResults[0]!.result.includes('Free all day'))
		assert.equal(toolState.toolDefinitions.length, 2)
		assert.equal(toolState.toolDefinitions[0]!.name, 'checkCalendar')
		assert.equal(toolState.toolDefinitions[1]!.name, 'bookMeeting')

		actor.stop()
	})
})
