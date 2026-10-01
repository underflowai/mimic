export type ToolKind = 'read' | 'write'

export interface TranscriptToolEvent {
	type: 'caller_turn_start' | 'caller_update' | 'caller_eager_turn' | 'caller_turn_resumed' | 'caller_turn_complete'
	transcript: string
	confidence?: number
	recordedAtMs: number
}

// ---------------------------------------------------------------------------
// Verified-actions audit trail
// ---------------------------------------------------------------------------

/** Where a WRITE argument's value was corroborated. */
export interface ToolEvidenceSpan {
	arg: string
	value: string
	/** `read_result:<toolName>` or `caller_turn`. */
	source: string
	/** The exact quote containing the value. */
	quote: string
}

export type ToolAuditEvent =
	| {
			phase: 'proposed'
			toolName: string
			args: Record<string, unknown> | null
			decision: 'execute' | 'not_ready'
			missingArgs: string[]
			atMs: number
	  }
	| {
			phase: 'gate'
			toolName: string
			args: Record<string, unknown>
			allowed: boolean
			reason: string | null
			evidence: ToolEvidenceSpan[]
			atMs: number
	  }
	| {
			phase: 'executed'
			toolName: string
			args: Record<string, unknown>
			ok: boolean
			result: string | null
			error: string | null
			elapsedMs: number
			atMs: number
	  }
