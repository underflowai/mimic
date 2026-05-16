/**
 * Webhook delivery with HMAC signature.
 *
 * @example
 * ```typescript
 * await deliverWebhook({
 *   url: 'https://example.com/webhook',
 *   payload: { event: 'call.completed', callId: '123', result },
 *   secret: 'whsec_...',
 * })
 * ```
 */

import { createHmac } from 'node:crypto'

export interface WebhookParams {
	url: string
	payload: unknown
	/** HMAC secret. If provided, the payload is signed and the signature sent in `x-mimic-signature`. */
	secret?: string
}

function signPayload(secret: string, body: string) {
	return createHmac('sha256', secret).update(body).digest('hex')
}

export async function deliverWebhook(params: WebhookParams) {
	const body = JSON.stringify(params.payload)
	const headers: Record<string, string> = { 'content-type': 'application/json' }
	if (params.secret) {
		headers['x-mimic-signature'] = `sha256=${signPayload(params.secret, body)}`
	}

	const response = await fetch(params.url, { method: 'POST', headers, body })
	if (!response.ok) {
		throw new Error(`Webhook delivery failed: ${response.status} ${response.statusText}`)
	}
}
