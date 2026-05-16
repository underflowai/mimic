import {
	AudioSource,
	AudioStream,
	LocalAudioTrack,
	Room,
	RoomEvent,
	TrackKind,
	TrackPublishOptions,
	type RemoteParticipant,
	type RemoteTrack,
	type RemoteTrackPublication,
} from '@livekit/rtc-node'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CallMetrics, CallOrchestrator, CallTurn } from '@mimic/engine'
import { createLiveKitTransport } from '@mimic/engine/src/audio/streams/livekit-sink.js'
import type { AudioTransport } from '@mimic/engine/src/audio/streams/types.js'
import { createAmbienceTrack } from './ambience-track.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AMBIENCE_FILE = join(__dirname, 'audio/office-ambience.mp3')

const TTS_SAMPLE_RATE = 48000
const ASR_SAMPLE_RATE = 16000
const DEFAULT_SESSION_TIMEOUT_MS = 60 * 60 * 1000

export interface OrchestratorCloseResult {
	turns: CallTurn[]
	turnCount: number
	durationSeconds: number
	metrics: CallMetrics
}

export interface VoiceAgentConfig {
	roomName: string
	identity: string
	logPrefix: string
	sessionTimeoutMs?: number
	grants?: { canPublish?: boolean; canSubscribe?: boolean }

	livekitUrl: string
	livekitAgentUrl?: string
	livekitApiKey: string
	livekitApiSecret: string

	ambience?: { enabled?: boolean; gain?: number }

	orchestrator?: CallOrchestrator
	createOrchestrator?: (transport: AudioTransport) => Promise<CallOrchestrator>

	connectServices(): Promise<void>
	onAudioReceived?(pcm: Buffer): void
	onReady?(): Promise<void>
	onSessionEnd(result: OrchestratorCloseResult | null): Promise<void>

	backchannelClips?: ReadonlyMap<string, Buffer>
}

export interface VoiceAgentHandle {
	roomName: string
	sessionComplete: Promise<void>
	playBackchannelClip: (token: string) => void
}

export async function createVoiceAgent(agentConfig: VoiceAgentConfig): Promise<VoiceAgentHandle> {
	const {
		roomName,
		identity,
		logPrefix,
		sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
		createOrchestrator,
		connectServices,
		onReady,
		onSessionEnd,
		livekitUrl,
		livekitApiKey,
		livekitApiSecret,
	} = agentConfig

	const livekitAgentUrl = agentConfig.livekitAgentUrl ?? livekitUrl

	if (agentConfig.orchestrator && createOrchestrator) {
		throw new Error('createVoiceAgent: pass either `orchestrator` or `createOrchestrator`, not both')
	}

	const hasAgent = Boolean(agentConfig.orchestrator || createOrchestrator)

	const prefix = `[${logPrefix}]`
	const grants = agentConfig.grants ?? (hasAgent ? { canPublish: true, canSubscribe: true } : { canSubscribe: true })

	const token = new AccessToken(livekitApiKey, livekitApiSecret, { identity, ttl: 3600 })
	token.addGrant({ roomJoin: true, room: roomName, ...grants })
	const agentToken = await token.toJwt()

	let audioSource: AudioSource | null = null
	let agentTrack: LocalAudioTrack | null = null
	let orchestrator: CallOrchestrator | null = null
	let transport: AudioTransport | null = null
	let ambienceStop: (() => void) | null = null

	if (hasAgent) {
		audioSource = new AudioSource(TTS_SAMPLE_RATE, 1, 300)
		agentTrack = LocalAudioTrack.createAudioTrack('mimic-voice', audioSource)
		transport = createLiveKitTransport({ audioSource, logPrefix })
		if (createOrchestrator) {
			orchestrator = await createOrchestrator(transport)
		} else if (agentConfig.orchestrator) {
			orchestrator = agentConfig.orchestrator
			orchestrator.bindAudioTransport(transport)
		}
	}

	const onAudioReceived = agentConfig.onAudioReceived ?? orchestrator?.handleCallerAudio

	const backchannelGain = 0.7

	function playBackchannelClip(token: string) {
		const clip = agentConfig.backchannelClips?.get(token)
		if (!clip || !transport || !transport.isOpen()) return
		if (orchestrator?.isAgentSpeaking()) return

		const source = new Int16Array(clip.buffer, clip.byteOffset, clip.byteLength / 2)
		const samples = new Int16Array(source.length)
		for (let i = 0; i < source.length; i++) {
			samples[i] = Math.round(source[i] * backchannelGain)
		}
		const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
		transport.playBackchannelFrame(pcm)
	}

	const room = new Room()

	room.on(
		RoomEvent.TrackSubscribed,
		async (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
			if (track.kind !== TrackKind.KIND_AUDIO) return
			console.log(`${prefix} subscribed to audio from ${participant.identity}`)

			const { BackgroundVoiceCancellation } = await import('@livekit/noise-cancellation-node')
			const stream = new AudioStream(track, {
				sampleRate: ASR_SAMPLE_RATE,
				numChannels: 1,
				noiseCancellation: BackgroundVoiceCancellation(),
			})
			const reader = stream.getReader()

			void (async () => {
				try {
					while (true) {
						const { done, value: frame } = await reader.read()
						if (done) break
						const pcm = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)
						onAudioReceived?.(pcm)
					}
				} catch (err) {
					console.error(`${prefix} audio stream read error:`, err)
				}
				console.log(`${prefix} audio stream from ${participant.identity} ended`)
			})()
		},
	)

	let sessionCompleted = false
	let sessionTimeout: ReturnType<typeof setTimeout> | undefined

	const { promise: sessionComplete, resolve: resolveSession } = Promise.withResolvers<void>()

	async function completeSession() {
		clearTimeout(sessionTimeout)

		let result: OrchestratorCloseResult | null = null
		if (orchestrator) {
			result = (await orchestrator.close()) as OrchestratorCloseResult
		}

		try {
			await onSessionEnd(result)
		} catch (err) {
			console.error(`${prefix} onSessionEnd failed:`, err)
		}

		ambienceStop?.()
		if (agentTrack) await agentTrack.close()
		if (audioSource) await audioSource.close()
		await room.disconnect()

		try {
			const roomService = new RoomServiceClient(livekitUrl, livekitApiKey, livekitApiSecret)
			await roomService.deleteRoom(roomName)
		} catch (err) {
			console.error(`${prefix} failed to delete room ${roomName}:`, err)
		}

		resolveSession()
	}

	function triggerComplete() {
		if (sessionCompleted) return
		sessionCompleted = true
		void completeSession()
	}

	room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
		console.log(`${prefix} participant ${participant.identity} disconnected`)
		triggerComplete()
	})

	room.on(RoomEvent.Disconnected, () => {
		console.log(`${prefix} disconnected from room`)
		triggerComplete()
	})

	orchestrator?.onHangupRequested(() => {
		console.log(`${prefix} hangup requested by orchestrator`)
		triggerComplete()
	})

	console.log(`${prefix} connecting to room ${roomName}`)
	try {
		await Promise.all([room.connect(livekitAgentUrl, agentToken), connectServices()])
		console.log(`${prefix} connected`)

		if (agentTrack) {
			await room.localParticipant!.publishTrack(agentTrack, new TrackPublishOptions())
		}

		const ambienceConfig = agentConfig.ambience ?? { enabled: true, gain: 0.05 }
		if (ambienceConfig.enabled) {
			try {
				const ambience = createAmbienceTrack({ filePath: AMBIENCE_FILE, gain: ambienceConfig.gain ?? 0.05 })
				await room.localParticipant!.publishTrack(ambience.track, new TrackPublishOptions())
				const abortController = new AbortController()
				ambience.loop(abortController.signal)
				ambienceStop = () => {
					ambience.stop()
					abortController.abort()
				}
			} catch (err) {
				console.error(`${prefix} failed to start ambience track:`, err)
			}
		}

		await onReady?.()

		if (orchestrator) {
			if (room.remoteParticipants.size === 0) {
				console.log(`${prefix} waiting for caller to join room`)
				await new Promise<void>((resolve, reject) => {
					const onJoin = () => {
						room.off(RoomEvent.Disconnected, onDisconnect)
						resolve()
					}
					const onDisconnect = () => {
						room.off(RoomEvent.ParticipantConnected, onJoin)
						reject(new Error('room disconnected before caller joined'))
					}
					room.once(RoomEvent.ParticipantConnected, onJoin)
					room.once(RoomEvent.Disconnected, onDisconnect)
				})
			}
			await new Promise((resolve) => setTimeout(resolve, 500))
			console.log(`${prefix} caller ready, starting orchestrator`)
			await orchestrator.start()
		}

		sessionTimeout = setTimeout(() => {
			console.warn(`${prefix} session timeout reached for room ${roomName}, force-closing`)
			triggerComplete()
		}, sessionTimeoutMs)
	} catch (err) {
		clearTimeout(sessionTimeout)
		console.error(`${prefix} failed during startup:`, err)
		if (audioSource)
			await audioSource.close().catch((e) => console.error(`${prefix} cleanup: audioSource.close failed:`, e))
		if (agentTrack)
			await agentTrack.close().catch((e) => console.error(`${prefix} cleanup: agentTrack.close failed:`, e))
		await room.disconnect().catch((e) => console.error(`${prefix} cleanup: room.disconnect failed:`, e))
		throw err
	}

	return { roomName, sessionComplete, playBackchannelClip }
}
