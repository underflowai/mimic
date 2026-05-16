export type { BackchannelClassifier } from './classifier.js'
export type { BackchannelEngine, BackchannelEngineConfig, BackchannelEngineDeps, BackchannelToken } from './engine.js'

export type BackchannelCallerTurnEvent =
	| { type: 'error'; message: string }
	| { type: 'turn_start'; transcript: string; confidence: number }
	| { type: 'update'; transcript: string; confidence: number }
	| { type: 'eager_turn'; transcript: string; confidence: number }
	| { type: 'turn_complete'; transcript: string; confidence: number }
	| { type: 'turn_resumed'; transcript: string }

type BackchannelTurnOutcomeBase = { kind: 'interrupted' | 'committed' | 'discarded' | 'deferred' }

export type BackchannelTurnOutcome = BackchannelTurnOutcomeBase & Record<string, unknown>
