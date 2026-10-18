import { AccessToken } from 'livekit-server-sdk'

/** Long enough to cover a slow page load and a long call; the room itself ends the session. */
export const WEB_JOIN_TTL_SECONDS = 60 * 60

export interface WebJoin {
	/** LiveKit server URL the browser connects to. */
	url: string
	/** Room-scoped join token for the browser participant. */
	token: string
}

export interface WebJoinInput {
	callId: string
	/** Display name for the participant, e.g. the recipient's first name. */
	name?: string
	livekit: { url: string; apiKey: string; apiSecret: string }
}

export function callRoomName(callId: string): string {
	return `mimic-call-${callId}`
}

/**
 * Mint the browser's credentials for a web call. The grant is limited to the
 * call's own room with publish and subscribe only, and the identity matches
 * what the SIP leg would have used, so the agent side is channel-agnostic.
 */
export async function createWebJoin(input: WebJoinInput): Promise<WebJoin> {
	const token = new AccessToken(input.livekit.apiKey, input.livekit.apiSecret, {
		identity: `caller-${input.callId}`,
		name: input.name,
		ttl: WEB_JOIN_TTL_SECONDS,
	})
	token.addGrant({ roomJoin: true, room: callRoomName(input.callId), canPublish: true, canSubscribe: true })
	return { url: input.livekit.url, token: await token.toJwt() }
}
