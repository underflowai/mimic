/**
 * SIP outbound dialing via LiveKit.
 *
 * Wraps LiveKit's SipClient to dial a phone number via a Twilio SIP trunk,
 * placing the recipient into a LiveKit room where the voice agent joins.
 */

import { SipClient, TwirpError } from 'livekit-server-sdk'

export interface SipConfig {
	livekitUrl: string
	livekitApiKey: string
	livekitApiSecret: string
	outboundTrunkId: string
}

export interface DialOptions {
	/** Phone number to dial (E.164 format). */
	phoneNumber: string
	/** LiveKit room name. The voice agent should join this same room. */
	roomName: string
	/** Identity for the SIP participant in the room. */
	participantIdentity?: string
	/** Display name for the SIP participant. */
	participantName?: string
	/** Enable Krisp noise cancellation on the SIP leg. Defaults to `true`. */
	krispEnabled?: boolean
	/** Block until the callee answers. Defaults to `true`. */
	waitUntilAnswered?: boolean
}

export interface DialResult {
	roomName: string
	phoneNumber: string
}

/**
 * Dial a phone number via LiveKit SIP and place the callee into a room.
 *
 * @throws {SipDialError} If the SIP call fails (includes SIP status code when available).
 *
 * @example
 * ```typescript
 * const sip = createSipDialer({
 *   livekitUrl: process.env.LIVEKIT_URL!,
 *   livekitApiKey: process.env.LIVEKIT_API_KEY!,
 *   livekitApiSecret: process.env.LIVEKIT_API_SECRET!,
 *   outboundTrunkId: process.env.LIVEKIT_SIP_TRUNK_ID!,
 * })
 *
 * const { roomName } = await sip.dial({
 *   phoneNumber: '+15551234567',
 *   roomName: 'call-abc123',
 * })
 * ```
 */
export function createSipDialer(config: SipConfig) {
	const client = new SipClient(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret)

	return {
		async dial(options: DialOptions): Promise<DialResult> {
			const identity = options.participantIdentity ?? `caller-${options.roomName}`
			const name = options.participantName ?? options.phoneNumber

			try {
				await client.createSipParticipant(config.outboundTrunkId, options.phoneNumber, options.roomName, {
					participantIdentity: identity,
					participantName: name,
					krispEnabled: options.krispEnabled ?? true,
					waitUntilAnswered: options.waitUntilAnswered ?? true,
				})

				return { roomName: options.roomName, phoneNumber: options.phoneNumber }
			} catch (error) {
				const sipCode =
					error instanceof TwirpError
						? (error.metadata as Record<string, string>)?.['sip_status_code']
						: undefined
				const message = sipCode
					? `SIP ${sipCode}: ${error instanceof Error ? error.message : String(error)}`
					: error instanceof Error
						? error.message
						: 'Unknown SIP error'
				throw new SipDialError(message, sipCode, error instanceof Error ? error : undefined)
			}
		},
	}
}

/** Thrown when an outbound SIP dial fails. */
export class SipDialError extends Error {
	constructor(
		message: string,
		/** SIP status code (e.g. '486' for busy, '408' for no answer), if available. */
		readonly sipStatusCode?: string,
		readonly cause?: Error,
	) {
		super(message)
		this.name = 'SipDialError'
	}
}
