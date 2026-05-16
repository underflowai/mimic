import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { flushImmediate } from '#test/support/async.js'
import { createOrchestratorRuntime } from './orchestrator-runtime.js'

function createHarness() {
	const handlers = new Map<string, (...args: unknown[]) => void>()
	const transcriber = {
		connect: mock.fn(async () => {}),
		close: mock.fn(async () => {}),
		sendAudio: mock.fn((_audio: Buffer) => {}),
		configure: mock.fn((_opts: unknown) => {}),
		on: mock.fn((event: string, callback: (...args: unknown[]) => void) => {
			handlers.set(event, callback)
		}),
	}
	const ttsConnect = mock.fn(async () => {})
	const ttsClose = mock.fn(() => {})
	const tts = {
		connect: ttsConnect,
		close: ttsClose,
	} as never
	const specTtsConnect = mock.fn(async () => {})
	const specTtsClose = mock.fn(() => {})
	const specTts = {
		connect: specTtsConnect,
		close: specTtsClose,
	} as never
	const turnEngine = {
		sendToCallMachine: mock.fn((_event: { type: string; [key: string]: unknown }) => {}),
	}
	const backchannelEngine = {
		send: mock.fn((_event: unknown) => {}),
	}
	const vad = {
		processAudio: mock.fn((_audio: Buffer) => {}),
		destroy: mock.fn(() => {}),
	}
	const ensureBackchannelEngine = mock.fn(() => {})
	const createVoiceActivityDetector = mock.fn(
		async (_callbacks: { onSpeechStart: () => void; onSpeechEnd: () => void }) => vad,
	)

	const runtime = createOrchestratorRuntime({
		log: {
			info: () => {},
			warn: () => {},
			error: () => {},
		},
		transcriber,
		tts,
		specTts,
		callMachineRuntime: turnEngine as never,
		createVoiceActivityDetector,
		getBackchannelEngine: () => backchannelEngine as never,
		ensureBackchannelEngine,
		buildOpeningBlock: () => 'opening block',
		getCallKeyterms: () => ['fleet', 'broker'],
	})

	return {
		runtime,
		handlers,
		transcriber,
		ttsConnect,
		ttsClose,
		specTtsConnect,
		specTtsClose,
		turnEngine,
		backchannelEngine,
		vad,
		ensureBackchannelEngine,
		createVoiceActivityDetector,
	}
}

describe('createOrchestratorRuntime', () => {
	it('connectServices initializes transcriber, tts, and vad', async () => {
		const h = createHarness()
		await h.runtime.connectServices()

		assert.equal(h.transcriber.connect.mock.calls.length, 1)
		assert.equal(h.ttsConnect.mock.calls.length, 1)
		assert.equal(h.createVoiceActivityDetector.mock.calls.length, 1)
		assert.equal(h.ensureBackchannelEngine.mock.calls.length, 1)
	})

	it('connectServices is idempotent', async () => {
		const h = createHarness()
		await Promise.all([h.runtime.connectServices(), h.runtime.connectServices()])
		assert.equal(h.transcriber.connect.mock.calls.length, 1)
		assert.equal(h.ttsConnect.mock.calls.length, 1)
		assert.equal(h.createVoiceActivityDetector.mock.calls.length, 1)
	})

	it('wires transcriber error listeners before connect', async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>()
		const callOrder: string[] = []
		const callMachineRuntime = { sendToCallMachine: mock.fn((_event: { type: string; [key: string]: unknown }) => {}) }
		const transcriber = {
			connect: mock.fn(async () => {
				callOrder.push('connect')
				handlers.get('error')?.('INACTIVE_CLIENT')
			}),
			close: mock.fn(async () => {}),
			sendAudio: mock.fn((_audio: Buffer) => {}),
			configure: mock.fn((_opts: unknown) => {}),
			on: mock.fn((event: string, callback: (...args: unknown[]) => void) => {
				callOrder.push(`on:${event}`)
				handlers.set(event, callback)
			}),
		}
		const runtime = createOrchestratorRuntime({
			log: { info: () => {}, warn: () => {}, error: () => {} },
			transcriber: transcriber as never,
			tts: { connect: mock.fn(async () => {}), close: mock.fn(() => {}) } as never,
			specTts: { connect: mock.fn(async () => {}), close: mock.fn(() => {}) } as never,
			callMachineRuntime: callMachineRuntime as never,
			createVoiceActivityDetector: mock.fn(async () => ({
				processAudio: mock.fn((_audio: Buffer) => {}),
				destroy: mock.fn(() => {}),
			})) as never,
			getBackchannelEngine: () => null,
			ensureBackchannelEngine: () => {},
			buildOpeningBlock: () => 'opening block',
			getCallKeyterms: () => [],
		})

		await runtime.connectServices()

		const connectIndex = callOrder.indexOf('connect')
		const errorHandlerIndex = callOrder.indexOf('on:error')
		assert.ok(errorHandlerIndex !== -1)
		assert.ok(connectIndex !== -1)
		assert.ok(errorHandlerIndex < connectIndex)
		assert.equal(callMachineRuntime.sendToCallMachine.mock.calls.length, 1)
		assert.deepEqual(callMachineRuntime.sendToCallMachine.mock.calls[0]?.arguments[0], {
			type: 'transcriber_error',
			message: 'INACTIVE_CLIENT',
		})
	})

	it('start wires transcriber events and runs first turn', async () => {
		const h = createHarness()
		await h.runtime.start()

		assert.equal(h.turnEngine.sendToCallMachine.mock.calls[0]!.arguments[0].type, 'start_first_turn')
		assert.equal(h.turnEngine.sendToCallMachine.mock.calls[0]!.arguments[0].openingBlock, 'opening block')
		assert.equal(h.transcriber.configure.mock.calls.length, 1)
		assert.deepEqual(h.transcriber.configure.mock.calls[0]!.arguments[0], { keyterms: ['fleet', 'broker'] })

		h.handlers.get('callerTurn')?.({ type: 'turn_start', transcript: 'hello', confidence: 0.5 })
		assert.equal(h.turnEngine.sendToCallMachine.mock.calls.length >= 1, true)
		assert.equal(h.turnEngine.sendToCallMachine.mock.calls[1]!.arguments[0].type, 'caller_turn_start')
		assert.equal(h.backchannelEngine.send.mock.calls.length >= 1, true)

		h.handlers.get('callerTurn')?.({ type: 'update', transcript: 'working', confidence: 0.7 })
		assert.equal(h.turnEngine.sendToCallMachine.mock.calls[2]!.arguments[0].type, 'caller_update')
		assert.equal(h.backchannelEngine.send.mock.calls.length >= 2, true)

		h.handlers.get('callerTurn')?.({ type: 'eager_turn', transcript: 'spec', confidence: 0.9 })
		await flushImmediate()
		assert.equal(h.turnEngine.sendToCallMachine.mock.calls[3]!.arguments[0].type, 'caller_eager_turn')

		h.handlers.get('callerTurn')?.({ type: 'turn_resumed', transcript: 'resume' })
		assert.equal(h.turnEngine.sendToCallMachine.mock.calls[4]!.arguments[0].type, 'caller_turn_resumed')

		h.handlers.get('callerTurn')?.({ type: 'turn_complete', transcript: 'done', confidence: 0.8 })
		await flushImmediate()
		assert.equal(h.backchannelEngine.send.mock.calls.length >= 3, true)
		assert.equal(h.turnEngine.sendToCallMachine.mock.calls[5]!.arguments[0].type, 'caller_turn_complete')
	})

	it('allows start to retry after a first-turn failure', async () => {
		const h = createHarness()
		let callCount = 0
		h.turnEngine.sendToCallMachine = mock.fn((event: { type: string }) => {
			if (event.type !== 'start_first_turn') return
			callCount++
			if (callCount === 1) throw new Error('boom')
		})

		await assert.rejects(() => h.runtime.start(), /boom/)
		await h.runtime.start()

		assert.equal(
			h.turnEngine.sendToCallMachine.mock.calls.filter((call) => call.arguments[0].type === 'start_first_turn').length,
			2,
		)
		assert.equal(h.transcriber.on.mock.calls.length > 0, true)
	})

	it('routes caller audio to transcriber, backchannel engine, and vad', async () => {
		const h = createHarness()
		await h.runtime.connectServices()
		const frame = Buffer.alloc(320, 1)

		h.runtime.handleCallerAudio(frame)

		assert.equal(h.transcriber.sendAudio.mock.calls.length, 1)
		assert.equal(h.transcriber.sendAudio.mock.calls[0]!.arguments[0], frame)
		assert.equal(h.vad.processAudio.mock.calls.length, 1)
	})

	it('shutdown closes transcriber and tears down vad', async () => {
		const h = createHarness()
		await h.runtime.connectServices()
		await h.runtime.shutdown()

		assert.equal(h.transcriber.close.mock.calls.length, 1)
		assert.equal(h.ttsClose.mock.calls.length, 1)
		assert.equal(h.specTtsClose.mock.calls.length, 1)
		assert.equal(h.vad.destroy.mock.calls.length, 1)
	})
})
