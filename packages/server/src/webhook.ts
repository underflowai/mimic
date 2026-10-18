/**
 * Webhook delivery: a few tries with backoff, optionally signed.
 *
 * Signature header, when a secret is set:
 *   x-mimic-signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<body>">
 * The SDK's `verifyWebhook` checks it (and rejects stale timestamps).
 */

import { createHmac } from 'node:crypto'

export interface WebhookParams {
	url: string
	payload: unknown
	/** HMAC key. Without one the delivery is unsigned. */
	secret?: string | null
	/** Injectable for tests. */
	fetchImpl?: typeof fetch
	/** Delays before each retry. Defaults to 1s, 5s, 20s. */
	retryDelaysMs?: number[]
}

const ATTEMPT_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 20_000]

export function signWebhook(secret: string, body: string, timestampSeconds = Math.floor(Date.now() / 1000)) {
	const digest = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')
	return `t=${timestampSeconds},v1=${digest}`
}

/** Resolves once the endpoint answers 2xx; throws after the last retry. */
export async function deliverWebhook(params: WebhookParams) {
	const body = JSON.stringify(params.payload)
	const headers: Record<string, string> = { 'content-type': 'application/json' }
	if (params.secret) headers['x-mimic-signature'] = signWebhook(params.secret, body)
	const fetchImpl = params.fetchImpl ?? fetch
	const delays = params.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS

	let lastError: Error | null = null
	for (let attempt = 0; attempt <= delays.length; attempt++) {
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]))
		try {
			const response = await fetchImpl(params.url, {
				method: 'POST',
				headers,
				body,
				signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
			})
			if (response.ok) return
			lastError = new Error(`Webhook delivery failed: ${response.status} ${response.statusText}`)
			// The endpoint rejected the request itself; the same body will not do better next time.
			if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) break
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err))
		}
	}
	throw lastError ?? new Error('Webhook delivery failed')
}
