/**
 * Check that a webhook delivery came from Mimic and is recent.
 *
 * The server sends `x-mimic-signature: t=<unix seconds>,v1=<hex>` where the
 * hex is HMAC-SHA256 of `<t>.<raw body>` under your `webhookSecret`. Verify
 * against the raw request body, before any JSON parsing.
 *
 * @example
 * ```typescript
 * app.post('/mimic', async (req, res) => {
 *   const ok = await verifyWebhook({
 *     payload: req.rawBody,
 *     signature: req.header('x-mimic-signature'),
 *     secret: process.env.MIMIC_WEBHOOK_SECRET!,
 *   })
 *   if (!ok) return res.status(401).end()
 *   const { event, call } = JSON.parse(req.rawBody) as WebhookEvent
 * })
 * ```
 */
export async function verifyWebhook(params: {
	/** The raw request body, exactly as received. */
	payload: string
	/** The `x-mimic-signature` header, however your framework hands it to you. */
	signature: string | string[] | null | undefined
	/** The `webhookSecret` the call was made with. */
	secret: string
	/** How old a delivery may be, in seconds. Defaults to 300. */
	toleranceSeconds?: number
}): Promise<boolean> {
	const header = Array.isArray(params.signature) ? params.signature[0] : params.signature
	const parts = Object.fromEntries((header ?? '').split(',').map((part) => part.split('=', 2)))
	const timestamp = Number(parts.t)
	const provided = typeof parts.v1 === 'string' ? parts.v1 : ''
	if (!Number.isFinite(timestamp) || provided.length !== 64) return false
	if (Math.abs(Date.now() / 1000 - timestamp) > (params.toleranceSeconds ?? 300)) return false

	const encoder = new TextEncoder()
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(params.secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${params.payload}`))
	const expected = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')

	// Constant-time compare; both strings are 64 hex characters.
	let mismatch = 0
	for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i)
	return mismatch === 0
}
