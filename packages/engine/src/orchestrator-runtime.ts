import type { CallerTurnEvent, FluxConfigureOptions, TtsSpeaker, VoiceActivityDetector } from './audio/types.js'
import type { BackchannelEngine } from './backchannel/types.js'

interface RuntimeLogger {
	info: (...args: unknown[]) => void
	warn: (...args: unknown[]) => void
	error: (...args: unknown[]) => void
}

type TranscriberEventName = 'error' | 'callerTurn'
type TranscriberListener = (...args: unknown[]) => void

interface RuntimeTranscriber {
	connect(): Promise<void>
	close(): Promise<void>
	sendAudio(audioBytes: Buffer): void
	configure(options: FluxConfigureOptions): void
	on(event: TranscriberEventName, callback: TranscriberListener): void
	off?: (event: TranscriberEventName, callback: TranscriberListener) => void
	removeAllListeners?: () => void
}

interface RuntimeCallMachineRuntime {
	sendToCallMachine(event: { type: string; [key: string]: unknown }): void
}

export interface OrchestratorRuntimeDeps {
	log: RuntimeLogger
	transcriber: RuntimeTranscriber
	tts: TtsSpeaker
	specTts: TtsSpeaker
	callMachineRuntime: RuntimeCallMachineRuntime
	createVoiceActivityDetector: (callbacks: {
		onSpeechStart: () => void
		onSpeechEnd: () => void
	}) => Promise<VoiceActivityDetector>
	getBackchannelEngine: () => BackchannelEngine | null
	ensureBackchannelEngine: () => void
	buildOpeningBlock: () => string
	getCallKeyterms: () => string[] | undefined
}

export function createOrchestratorRuntime(deps: OrchestratorRuntimeDeps) {
	let transcriberReady: Promise<void> | null = null
	let ttsReady: Promise<void> | null = null
	let connectPromise: Promise<void> | null = null
	let startPromise: Promise<void> | null = null
	let vad: VoiceActivityDetector | null = null
	let hasStarted = false

	// Keep hold of every registered transcriber listener so shutdown can detach
	// them. Prevents listener leaks if the runtime were to be re-used and also
	// avoids zombie handlers firing after teardown.
	const transcriberListeners: Array<[TranscriberEventName, TranscriberListener]> = []

	function dispatchCallerTurnEvent(event: CallerTurnEvent) {
		deps.getBackchannelEngine()?.send({ type: 'caller_turn_event', event })
		switch (event.type) {
			case 'error':
				deps.log.error({ msg: event.message }, 'transcriber error')
				deps.callMachineRuntime.sendToCallMachine({
					type: 'transcriber_error',
					message: event.message,
				})
				return
			case 'turn_start':
				deps.callMachineRuntime.sendToCallMachine({
					type: 'caller_turn_start',
					transcript: event.transcript,
					confidence: event.confidence,
				})
				return
			case 'update':
				deps.callMachineRuntime.sendToCallMachine({
					type: 'caller_update',
					transcript: event.transcript,
					confidence: event.confidence,
				})
				return
			case 'eager_turn':
				deps.callMachineRuntime.sendToCallMachine({
					type: 'caller_eager_turn',
					transcript: event.transcript,
					confidence: event.confidence,
				})
				return
			case 'turn_resumed':
				deps.callMachineRuntime.sendToCallMachine({ type: 'caller_turn_resumed', transcript: event.transcript })
				return
			case 'turn_complete':
				deps.callMachineRuntime.sendToCallMachine({
					type: 'caller_turn_complete',
					transcript: event.transcript,
					confidence: event.confidence,
				})
				return
		}
	}

	function wireTranscriberEvents() {
		if (transcriberListeners.length > 0) return

		const pairs: Array<[TranscriberEventName, TranscriberListener]> = [
			['error', (msg) => dispatchCallerTurnEvent({ type: 'error', message: typeof msg === 'string' ? msg : '' })],
			[
				'callerTurn',
				(event) => {
					if (!event || typeof event !== 'object') return
					const callerTurnEvent = event as CallerTurnEvent
					dispatchCallerTurnEvent(callerTurnEvent)
				},
			],
		]
		for (const [event, handler] of pairs) {
			deps.transcriber.on(event, handler)
			transcriberListeners.push([event, handler])
		}
	}

	async function connectServices() {
		if (connectPromise) return connectPromise
		connectPromise = (async () => {
			// Wire listeners before the websocket connect so any immediate
			// transcriber fatal event lands on a handler instead of crashing.
			wireTranscriberEvents()

			const t0 = Date.now()
			transcriberReady = deps.transcriber.connect()
			ttsReady = Promise.all([deps.tts.connect(), deps.specTts.connect()]).then(() => {})
			const vadReady = deps.createVoiceActivityDetector({
				onSpeechStart: () => deps.callMachineRuntime.sendToCallMachine({ type: 'vad_speech_start' }),
				onSpeechEnd: () => deps.callMachineRuntime.sendToCallMachine({ type: 'vad_speech_end' }),
			})
			const [transcriberResult, ttsResult, vadResult] = await Promise.allSettled([transcriberReady, ttsReady, vadReady])
			if (transcriberResult.status === 'rejected') {
				deps.log.error({ err: transcriberResult.reason }, 'transcriber connection failed')
				throw transcriberResult.reason
			}
			if (ttsResult.status === 'rejected') throw ttsResult.reason
			vad = vadResult.status === 'fulfilled' ? vadResult.value : null
			if (!vad) deps.log.error('VAD initialization failed, falling back to Deepgram-only interrupt detection')
			deps.ensureBackchannelEngine()
			deps.log.info({ elapsed: Date.now() - t0 }, 'services connected')
		})().catch((err) => {
			transcriberReady = null
			ttsReady = null
			vad = null
			connectPromise = null
			throw err
		})
		return connectPromise
	}

	async function start() {
		if (hasStarted) return
		if (startPromise) return startPromise
		startPromise = (async () => {
			await connectServices()

			deps.log.info('generating first turn')
			const openingBlock = deps.buildOpeningBlock()

			if (transcriberReady) {
				await transcriberReady
				const keyterms = deps.getCallKeyterms()
				if (keyterms && keyterms.length > 0) {
					deps.transcriber.configure({ keyterms })
				}
			}

			deps.callMachineRuntime.sendToCallMachine({ type: 'start_first_turn', openingBlock })
			hasStarted = true
		})().catch((err) => {
			hasStarted = false
			startPromise = null
			throw err
		})
		return startPromise
	}

	function handleCallerAudio(pcmBuffer: Buffer) {
		deps.transcriber.sendAudio(pcmBuffer)
		vad?.processAudio(pcmBuffer)
	}

	function detachTranscriberListeners() {
		if (deps.transcriber.removeAllListeners) {
			deps.transcriber.removeAllListeners()
		} else if (deps.transcriber.off) {
			for (const [event, handler] of transcriberListeners) {
				deps.transcriber.off(event, handler)
			}
		}
		transcriberListeners.length = 0
	}

	async function shutdown() {
		detachTranscriberListeners()
		// Order: stop ingress → stop outbound synthesis → release model.
		await deps.transcriber.close()
		deps.tts.close()
		deps.specTts.close()
		vad?.destroy()
		vad = null
	}

	return {
		connectServices,
		start,
		handleCallerAudio,
		shutdown,
	}
}

export type OrchestratorRuntime = ReturnType<typeof createOrchestratorRuntime>
