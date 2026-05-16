/**
 * Outbound call orchestration.
 *
 * Ties together SIP dialing, voice agent creation, and the Mimic engine
 * into a single function that dials a phone number, runs the voice agent,
 * and returns the result when the call ends.
 */

import { createCallOrchestrator, type CallOrchestratorConfig } from '@mimic/engine/src/orchestrator.js'
import type { AudioTransport } from '@mimic/engine/src/audio/streams/types.js'

import { createSipDialer, type SipConfig } from './sip.js'

export interface OrchestratorCloseResult {
	turns: Array<{ role: string; content: string }>
	turnCount: number
	durationSeconds: number
}

export interface VoiceAgentConfig {
	roomName: string
	identity: string
	logPrefix: string
	createOrchestrator: (transport: AudioTransport) => Promise<Awaited<ReturnType<typeof createCallOrchestrator>>>
	connectServices: () => Promise<void>
	onSessionEnd: (result: OrchestratorCloseResult | null) => Promise<void>
}

export interface OutboundCallConfig {
	sip: SipConfig
	/** Build the orchestrator config for this call. */
	orchestratorConfig: Omit<CallOrchestratorConfig, 'audioTransport' | 'callId'>
	/** Create the voice agent. Injected so the caller can provide their own LiveKit wiring. */
	createVoiceAgent: (config: VoiceAgentConfig) => Promise<{ sessionComplete: Promise<void> }>
}

export interface OutboundCallParams {
	/** Unique call ID for tracking. */
	callId: string
	/** Phone number to dial (E.164 format). */
	phoneNumber: string
	/** Optional recipient name (shown in LiveKit room). */
	recipientName?: string
}

export interface OutboundCallResult {
	callId: string
	roomName: string
	closeResult: OrchestratorCloseResult | null
}

/**
 * Dial a phone number, run the voice agent, and return the result.
 *
 * This is the server-side equivalent of what `mimic.call()` triggers
 * from the SDK. It:
 *
 * 1. Creates a LiveKit room and dials the phone number via SIP
 * 2. Spawns a Mimic voice agent into the room
 * 3. Waits for the call to end
 * 4. Returns the orchestrator close result (turns, metrics, duration)
 *
 * @example
 * ```typescript
 * const result = await runOutboundCall(
 *   {
 *     sip: sipConfig,
 *     orchestratorConfig: { systemPrompt, userFirstName, ... },
 *     createVoiceAgent,
 *   },
 *   {
 *     callId: 'call_123',
 *     phoneNumber: '+15551234567',
 *   },
 * )
 * ```
 */
export async function runOutboundCall(
	config: OutboundCallConfig,
	params: OutboundCallParams,
): Promise<OutboundCallResult> {
	const dialer = createSipDialer(config.sip)
	const roomName = `mimic-call-${params.callId}`

	await dialer.dial({
		phoneNumber: params.phoneNumber,
		roomName,
		participantIdentity: `caller-${params.callId}`,
		participantName: params.recipientName ?? params.phoneNumber,
	})

	let orchestratorRef: Awaited<ReturnType<typeof createCallOrchestrator>> | null = null
	let closeResult: OrchestratorCloseResult | null = null

	const { sessionComplete } = await config.createVoiceAgent({
		roomName,
		identity: `mimic-agent-${params.callId}`,
		logPrefix: `call-${params.callId}`,
		createOrchestrator: async (audioTransport) => {
			const orchestrator = await createCallOrchestrator({
				...config.orchestratorConfig,
				callId: params.callId,
				audioTransport,
			})
			orchestratorRef = orchestrator
			return orchestrator
		},
		connectServices: () => orchestratorRef!.connectServices(),
		async onSessionEnd(result) {
			closeResult = result
		},
	})

	await sessionComplete

	return { callId: params.callId, roomName, closeResult }
}
