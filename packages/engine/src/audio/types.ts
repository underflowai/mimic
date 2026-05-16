// ── Caller turn event ────────────────────────────────────────────────

export type CallerTurnEvent =
	| { type: 'error'; message: string }
	| { type: 'turn_start'; transcript: string; confidence: number }
	| { type: 'update'; transcript: string; confidence: number }
	| { type: 'eager_turn'; transcript: string; confidence: number }
	| { type: 'turn_resumed'; transcript: string }
	| { type: 'turn_complete'; transcript: string; confidence: number }

// ── Re-exports ───────────────────────────────────────────────────────

export type { StreamResult } from '../turn/actors/run-turn-actor.js'
export type {
	CreateDeepgramWebSocket,
	DeepgramTranscriberConfig,
	FluxConfigureOptions,
} from './deepgram-transcriber.js'
export type { ListenTranscriber } from './listen-transcriber.js'
export type { PauseGate } from './streams/pause-gate.js'
export type { PlaybackTracker } from './streams/playback-tracker.js'
export type { AudioSink, AudioTransport, PlaybackProgress } from './streams/types.js'
export type {
	TtsSocketSession,
	TtsSocketSessionOptions,
	CreateWebSocket as TtsWebSocketFactory,
} from './tts-session.js'
export type { CreateTtsSpeakerOptions, TtsSpeaker } from './tts-speaker.js'
export type { VadConfig, VoiceActivityDetector } from './vad.js'
