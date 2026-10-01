export { createCallOrchestrator } from './orchestrator.js'
export type {
	CallOrchestrator,
	CallOrchestratorConfig,
	CommittedTurnInfo,
	TurnControlBlockContext,
} from './orchestrator.js'
export { config } from './config.js'
export { loadPrompt, renderPromptTemplate } from './prompts.js'
export type { AudioSink, AudioTransport } from './audio/streams/types.js'

// Audio primitives for harnesses (self-play synthetic caller).
export { createTtsSpeaker } from './audio/tts-speaker.js'
export type { TtsSpeaker } from './audio/tts-speaker.js'
export { createListenTranscriber } from './audio/listen-transcriber.js'
export type { ListenTranscriber } from './audio/listen-transcriber.js'

export type { CallMetrics } from './shared/metrics.js'
export type { CallTurn } from './shared/prompt-turns.js'
export type { CommittedTurn, TurnOutcome } from './turn/types.js'
export type { InterruptContext } from './intelligence/types.js'
export type { ToolAuditEvent, ToolEvidenceSpan } from './intelligence/tools/types.js'

export { parseEventLog, serializeEventLog } from './replay/event-log.js'
export type { CallEventRecord } from './replay/event-log.js'
export {
	analyzeEarlyCommitGuards,
	analyzeSubstantiveSpeechThresholds,
	extractCallerGaps,
	summarizeCallerGaps,
	summarizeSeries,
} from './replay/timing-counterfactuals.js'
export { replayCall } from './replay/replay-harness.js'
export type { ReplayResult } from './replay/replay-harness.js'

export { arloPersona, auroraPersona } from './shared/voice-persona.js'
export type { VoicePersona } from './shared/voice-persona.js'

export { loadBackchannelClips } from './backchannel/clips.js'
export type { BackchannelToken } from './backchannel/engine.js'

export { formatUserDateTime } from './intelligence/control-block-utils.js'
