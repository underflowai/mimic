// ── Telephony ─────────────────────────────────────────────────────────

export { createSipDialer, SipDialError } from './sip.js'
export type { DialOptions, DialResult, SipConfig } from './sip.js'

export { runOutboundCall } from './outbound-call.js'
export type { OutboundCallConfig, OutboundCallParams, OutboundCallResult } from './outbound-call.js'

// ── Post-call ─────────────────────────────────────────────────────────

export { extractCallResult } from './result-extractor.js'
export type {
	ExtractionInput,
	ExtractionResult,
	SuccessCondition,
	ToolCallRecord,
	TranscriptEntry,
} from './result-extractor.js'

// ── Auth ──────────────────────────────────────────────────────────────

export { generateApiKey, verifyApiKey } from './auth.js'
export type { GeneratedKey } from './auth.js'

// ── Webhook ───────────────────────────────────────────────────────────

export { deliverWebhook } from './webhook.js'
export type { WebhookParams } from './webhook.js'

// ── Tool socket ───────────────────────────────────────────────────────

export { createToolSocketBridge, requestToolExecutionOverSocket } from './tool-socket.js'
export type { ToolSocketCallError, ToolSocketCallRequest, ToolSocketCallResult } from './tool-socket.js'

// ── Goal compiler ─────────────────────────────────────────────────────

export { compileGoal, buildOrchestratorConfigFromAgent } from './goal-compiler.js'
export type {
	AgentConfig,
	CompiledGoal,
	GoalCompilerInput,
	GoalContext,
	GoalData,
	GoalRecipient,
	GoalResults,
	GoalToolDefinition,
	GoalVoice,
} from './goal-compiler.js'
