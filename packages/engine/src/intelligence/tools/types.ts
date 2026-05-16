export type ToolKind = 'read' | 'write'

export interface TranscriptToolEvent {
	type: 'caller_turn_start' | 'caller_update' | 'caller_eager_turn' | 'caller_turn_resumed' | 'caller_turn_complete'
	transcript: string
	confidence?: number
	recordedAtMs: number
}
