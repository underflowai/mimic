import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createActor, createMachine, fromPromise } from 'xstate'

import {
	eagerMachine,
	type EagerMachineActor,
	type EagerPreparedResult,
	type ValidationResult,
} from './eager-machine.js'

function waitChild(child: EagerMachineActor, value: string) {
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			sub.unsubscribe()
			reject(new Error(`timed out waiting for ${value}, saw ${String(child.getSnapshot().value)}`))
		}, 500)
		const sub = child.subscribe((snapshot) => {
			if (snapshot.value !== value) return
			clearTimeout(timeout)
			sub.unsubscribe()
			resolve()
		})
		if (child.getSnapshot().value === value) {
			clearTimeout(timeout)
			sub.unsubscribe()
			resolve()
		}
	})
}

function createPreparedResult(transcript: string, controlBlock: string): EagerPreparedResult {
	return {
		agentResponse: `draft for ${transcript}`,
		userTranscript: transcript,
		controlBlock,
		sink: { chunks: [], done: true, forward: null },
		triggerSynthesisStart: () => {},
		ttsPromise: Promise.resolve(),
	}
}

function createSetup(opts?: { eagerDraft?: EagerPreparedResult | null; valid?: boolean }) {
	const parentEvents: Array<{ type: string; [key: string]: unknown }> = []
	const calls: string[] = []
	const provided = eagerMachine.provide({
		actors: {
			eagerGeneration: fromPromise<
				EagerPreparedResult | null,
				{ transcript: string; controlBlock: string; signal: AbortSignal }
			>(async ({ input }) =>
				opts && 'eagerDraft' in opts ? opts.eagerDraft! : createPreparedResult(input.transcript, input.controlBlock),
			),
			finalValidator: fromPromise(async () => ({ valid: opts?.valid ?? true })),
		},
		actions: {
			abortCurrent: (_, params) => {
				calls.push('abortCurrent')
				params.abort.abort()
			},
			interruptSpecTts: () => calls.push('interruptSpecTts'),
		},
	})
	const parent = createMachine({
		id: 'parent',
		types: {
			events: {} as
				| { type: 'eager_promotion_metrics'; [key: string]: unknown }
				| { type: 'promotion_resolved'; promoted: boolean },
		},
		invoke: { src: provided, id: 'eager' },
		on: {
			eager_promotion_metrics: { actions: ({ event }) => parentEvents.push({ ...event }) },
			promotion_resolved: { actions: ({ event }) => parentEvents.push({ ...event }) },
		},
	})
	const parentActor = createActor(parent).start()
	const child = parentActor.getSnapshot().children.eager as EagerMachineActor
	return { parentActor, child, parentEvents, calls }
}

function sendEagerTurn(child: EagerMachineActor, transcript = 'yes that works') {
	child.send({
		type: 'EAGER_TURN',
		transcript,
		controlBlock: 'control',
		turnId: 2,
	})
}

describe('eager machine', () => {
	it('generates an eager draft and prepares sink state', async () => {
		const { child, parentActor } = createSetup()

		sendEagerTurn(child)
		await waitChild(child, 'ready')

		assert.equal(child.getSnapshot().context.eagerDraft?.agentResponse, 'draft for yes that works')
		parentActor.stop()
	})

	it('returns idle when eager generation returns null', async () => {
		const { child, parentActor } = createSetup({ eagerDraft: null })

		sendEagerTurn(child)
		await waitChild(child, 'idle')

		assert.equal(child.getSnapshot().context.eagerDraft, null)
		parentActor.stop()
	})

	it('validates ready draft for the final transcript', async () => {
		const { child, parentEvents, parentActor } = createSetup({ valid: true })

		sendEagerTurn(child)
		await waitChild(child, 'ready')
		child.send({ type: 'FINAL_TURN_VALIDATE', transcript: 'yes that works', controlBlock: 'final', turnId: 2 })
		await waitChild(child, 'ready')

		assert.equal(child.getSnapshot().context.validatedTranscript, 'yes that works')
		assert.ok(parentEvents.some((event) => event.outcome === 'promoted'))
		assert.ok(parentEvents.some((event) => event.type === 'promotion_resolved' && event.promoted === true))
		parentActor.stop()
	})

	it('failed validation discards current draft', async () => {
		const { child, parentEvents, parentActor } = createSetup({ valid: false })

		sendEagerTurn(child)
		await waitChild(child, 'ready')
		child.send({ type: 'FINAL_TURN_VALIDATE', transcript: 'actually no', controlBlock: 'final', turnId: 2 })
		await waitChild(child, 'idle')

		assert.equal(child.getSnapshot().context.eagerDraft, null)
		assert.ok(parentEvents.some((event) => event.outcome === 'discarded_diverged'))
		assert.ok(parentEvents.some((event) => event.type === 'promotion_resolved' && event.promoted === false))
		parentActor.stop()
	})

	it('cancel aborts and resets active eager state', async () => {
		const { child, calls, parentActor } = createSetup()

		sendEagerTurn(child)
		await waitChild(child, 'ready')
		child.send({ type: 'CANCEL' })
		await waitChild(child, 'idle')

		assert.ok(calls.includes('abortCurrent'))
		assert.ok(calls.includes('interruptSpecTts'))
		assert.equal(child.getSnapshot().context.eagerDraft, null)
		parentActor.stop()
	})

	it('cancel clears speculative sink buffers and forwarding hook', async () => {
		const sink = {
			chunks: [Buffer.from('stale-audio')],
			done: false,
			forward: (_chunk: Buffer) => {},
		}
		const { child, parentActor } = createSetup({
			eagerDraft: {
				...createPreparedResult('yes that works', 'control'),
				sink,
			},
		})

		sendEagerTurn(child)
		await waitChild(child, 'ready')
		child.send({ type: 'CANCEL' })
		await waitChild(child, 'idle')

		assert.equal(sink.chunks.length, 0)
		assert.equal(sink.forward, null)
		assert.equal(sink.done, true)
		parentActor.stop()
	})

	it('marks ready draft stale when turn resumes', async () => {
		const { child, parentActor } = createSetup()

		sendEagerTurn(child)
		await waitChild(child, 'ready')
		child.send({ type: 'MARK_TURN_RESUMED' })

		assert.equal(child.getSnapshot().context.turnResumedSince, true)
		parentActor.stop()
	})

	it('FINAL_TURN_VALIDATE during eagerGenerating → validates after generation completes', async () => {
		let resolveGeneration!: (result: EagerPreparedResult) => void
		const parentEvents: Array<{ type: string; [key: string]: unknown }> = []
		const provided = eagerMachine.provide({
			actors: {
				eagerGeneration: fromPromise<
					EagerPreparedResult | null,
					{ transcript: string; controlBlock: string; signal: AbortSignal }
				>(
					({ input }) =>
						new Promise((resolve) => {
							resolveGeneration = () => resolve(createPreparedResult(input.transcript, input.controlBlock))
						}),
				),
				finalValidator: fromPromise(async (): Promise<ValidationResult> => ({ valid: true })),
			},
			actions: {
				abortCurrent: (_, params) => params.abort.abort(),
				interruptSpecTts: () => {},
			},
		})
		const parent = createMachine({
			id: 'parent',
			types: {
				events: {} as
					| { type: 'eager_promotion_metrics'; [key: string]: unknown }
					| { type: 'promotion_resolved'; promoted: boolean },
			},
			invoke: { src: provided, id: 'eager' },
			on: {
				eager_promotion_metrics: { actions: ({ event }) => parentEvents.push({ ...event }) },
				promotion_resolved: { actions: ({ event }) => parentEvents.push({ ...event }) },
			},
		})
		const parentActor = createActor(parent).start()
		const child = parentActor.getSnapshot().children.eager as EagerMachineActor

		sendEagerTurn(child)
		await waitChild(child, 'eagerGenerating')

		child.send({ type: 'FINAL_TURN_VALIDATE', transcript: 'yes that works', controlBlock: 'final', turnId: 2 })
		assert.equal(child.getSnapshot().value, 'eagerGenerating', 'stays in eagerGenerating until generation completes')
		assert.ok(child.getSnapshot().context.pendingValidate, 'pendingValidate is stashed')

		resolveGeneration(createPreparedResult('yes that works', 'control'))
		await waitChild(child, 'ready')

		assert.ok(parentEvents.some((event) => event.type === 'promotion_resolved' && event.promoted === true))
		parentActor.stop()
	})

	it('FINAL_TURN_VALIDATE during eagerGenerating → promotion_resolved false when generation fails', async () => {
		let resolveGeneration!: () => void
		const parentEvents: Array<{ type: string; [key: string]: unknown }> = []
		const provided = eagerMachine.provide({
			actors: {
				eagerGeneration: fromPromise<
					EagerPreparedResult | null,
					{ transcript: string; controlBlock: string; signal: AbortSignal }
				>(
					() =>
						new Promise((resolve) => {
							resolveGeneration = () => resolve(null)
						}),
				),
				finalValidator: fromPromise(async (): Promise<ValidationResult> => ({ valid: false })),
			},
			actions: {
				abortCurrent: (_, params) => params.abort.abort(),
				interruptSpecTts: () => {},
			},
		})
		const parent = createMachine({
			id: 'parent',
			types: {
				events: {} as
					| { type: 'eager_promotion_metrics'; [key: string]: unknown }
					| { type: 'promotion_resolved'; promoted: boolean },
			},
			invoke: { src: provided, id: 'eager' },
			on: {
				eager_promotion_metrics: { actions: ({ event }) => parentEvents.push({ ...event }) },
				promotion_resolved: { actions: ({ event }) => parentEvents.push({ ...event }) },
			},
		})
		const parentActor = createActor(parent).start()
		const child = parentActor.getSnapshot().children.eager as EagerMachineActor

		sendEagerTurn(child)
		await waitChild(child, 'eagerGenerating')
		child.send({ type: 'FINAL_TURN_VALIDATE', transcript: 'different', controlBlock: 'final', turnId: 2 })
		assert.ok(child.getSnapshot().context.pendingValidate, 'pendingValidate is stashed')

		resolveGeneration()
		await waitChild(child, 'idle')
		assert.ok(parentEvents.some((event) => event.type === 'promotion_resolved' && event.promoted === false))
		parentActor.stop()
	})
})
