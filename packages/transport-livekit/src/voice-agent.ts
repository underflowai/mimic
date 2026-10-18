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

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
	asrSampleRate,
	ttsSampleRate,
	type CallEventRecord,
	type CallMetrics,
	type CallOrchestrator,
	type CallTurn,
} from '@mimic/engine'
import { createLiveKitTransport, type AudioTransport } from '@mimic/engine/livekit-transport'
import { createAmbienceTrack } from './ambience-track.js'
import { waitForCaller } from './caller-wait.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AMBIENCE_FILE = join(__dirname, 'audio/office-ambience.mp3')
const HAS_AMBIENCE_FILE = existsSync(AMBIENCE_FILE)

const DEFAULT_SESSION_TIMEOUT_MS = 60 * 60 * 1000
/**
 * How much agent audio LiveKit buffers ahead of playout. Large enough to
 * absorb TTS jitter, small enough that a barge-in's unplayed tail stays
 * short (the engine measures that tail via `queuedDuration` when it works out
 * how much of a reply the caller actually heard).
 */
const AGENT_AUDIO_QUEUE_MS = 300
const DEFAULT_AMBIENCE = { enabled: true, gain: 0.05 } as const
/** Clips are mastered at full scale; mix them under the live voice. */
const BACKCHANNEL_GAIN = 0.7

export interface OrchestratorCloseResult {
	turns: CallTurn[]
	turnCount: number
	durationSeconds: number
	metrics: CallMetrics
	/** Per-call engine event log (JSONL-able); empty when nothing was recorded. */
	events: CallEventRecord[]
}

export interface VoiceAgentConfig {
	roomName: string
	identity: string
	logPrefix: string
	sessionTimeoutMs?: number
	/**
	 * How long to wait for the first remote participant before giving up.
	 * Unset means the far end is already in the room (SIP answers before the
	 * agent connects) and any wait is open-ended. Set it when the far end
	 * joins on its own schedule, such as a browser: speech services and
	 * `onReady` then wait for the caller too, because Deepgram drops a socket
	 * that has carried no audio for 60 seconds.
	 */
	callerJoinTimeoutMs?: number
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
		audioSource = new AudioSource(ttsSampleRate, 1, AGENT_AUDIO_QUEUE_MS)
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

	function playBackchannelClip(token: string) {
		const clip = agentConfig.backchannelClips?.get(token)
		if (!clip || !transport || !transport.isOpen()) return
		if (orchestrator?.isAgentSpeaking()) return

		const source = new Int16Array(clip.buffer, clip.byteOffset, clip.byteLength / Int16Array.BYTES_PER_ELEMENT)
		const samples = new Int16Array(source.length)
		for (let i = 0; i < source.length; i++) {
			samples[i] = Math.round(source[i] * BACKCHANNEL_GAIN)
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
				sampleRate: asrSampleRate,
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

	const { promise: sessionComplete, resolve: resolveSession, reject: rejectSession } = Promise.withResolvers<void>()

	/** Release local media, leave, and delete the room so nobody lingers in it. */
	async function teardown() {
		ambienceStop?.()
		if (agentTrack) await agentTrack.close().catch((err) => console.error(`${prefix} agentTrack.close failed:`, err))
		if (audioSource) await audioSource.close().catch((err) => console.error(`${prefix} audioSource.close failed:`, err))
		await room.disconnect().catch((err) => console.error(`${prefix} room.disconnect failed:`, err))
		try {
			const roomService = new RoomServiceClient(livekitUrl, livekitApiKey, livekitApiSecret)
			await roomService.deleteRoom(roomName)
		} catch (err) {
			console.error(`${prefix} failed to delete room ${roomName}:`, err)
		}
	}

	async function completeSession() {
		clearTimeout(sessionTimeout)

		let result: OrchestratorCloseResult | null = null
		let completionError: Error | null = null
		if (orchestrator) {
			try {
				result = (await orchestrator.close()) as OrchestratorCloseResult
			} catch (err) {
				completionError = err instanceof Error ? err : new Error(String(err))
				console.error(`${prefix} orchestrator.close failed:`, err)
			}
		}

		try {
			await onSessionEnd(result)
		} catch (err) {
			if (!completionError) completionError = err instanceof Error ? err : new Error(String(err))
			console.error(`${prefix} onSessionEnd failed:`, err)
		}

		await teardown()

		if (completionError) {
			rejectSession(completionError)
			return
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

	orchestrator?.onHangupRequested((source) => {
		console.log(`${prefix} hangup requested by orchestrator (${source})`)
		triggerComplete()
	})

	console.log(`${prefix} connecting to room ${roomName}`)
	try {
		// A phone leg is already in the room when the agent connects, so its
		// services come up alongside the join. A browser arrives on its own
		// schedule, and Deepgram drops a socket that has carried no audio for
		// 60 seconds, so in that case the services wait for the caller.
		const callerJoinsLater = agentConfig.callerJoinTimeoutMs !== undefined
		let servicesReady = callerJoinsLater ? null : connectServices()
		await Promise.all([room.connect(livekitAgentUrl, agentToken), servicesReady])
		console.log(`${prefix} connected`)

		if (agentTrack) {
			await room.localParticipant!.publishTrack(agentTrack, new TrackPublishOptions())
		}

		const ambienceConfig = { ...DEFAULT_AMBIENCE, ...agentConfig.ambience }
		if (ambienceConfig.enabled && HAS_AMBIENCE_FILE) {
			try {
				const ambience = createAmbienceTrack({ filePath: AMBIENCE_FILE, gain: ambienceConfig.gain })
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
		} else if (ambienceConfig.enabled && !HAS_AMBIENCE_FILE) {
			console.warn(`${prefix} ambience enabled but file missing at ${AMBIENCE_FILE}`)
		}

		if (orchestrator && room.remoteParticipants.size === 0) {
			console.log(`${prefix} waiting for caller to join room`)
			await waitForCaller(room, agentConfig.callerJoinTimeoutMs)
		}
		if (!servicesReady) servicesReady = connectServices()
		await servicesReady

		// Recording, and anything else set up for a live call, starts once there is someone on the other end.
		await onReady?.()

		if (orchestrator) {
			await new Promise((resolve) => setTimeout(resolve, 500))
			console.log(`${prefix} caller ready, starting orchestrator`)
			await orchestrator.start()
		}

		sessionTimeout = setTimeout(() => {
			console.warn(`${prefix} session timeout reached for room ${roomName}, force-closing`)
			triggerComplete()
		}, sessionTimeoutMs)
	} catch (err) {
		console.error(`${prefix} failed during startup:`, err)
		// The caller handles a failed start itself. Mark the session done first so
		// the disconnect in teardown does not run the end-of-session path on top.
		sessionCompleted = true
		if (orchestrator) {
			await orchestrator.close().catch((e) => console.error(`${prefix} cleanup: orchestrator.close failed:`, e))
		}
		await teardown()
		throw err
	}

	return { roomName, sessionComplete, playBackchannelClip }
}
