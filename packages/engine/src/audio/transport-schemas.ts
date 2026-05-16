import { z, ZodType } from 'zod'

// ── Cartesia TTS ────────────────────────────────────────────────────

export const cartesiaChunkSchema = z
	.object({
		type: z.literal('chunk'),
		data: z.string(),
		done: z.boolean(),
		status_code: z.number(),
		step_time: z.number().optional(),
		context_id: z.string(),
	})
	.passthrough()

export const cartesiaDoneSchema = z
	.object({
		type: z.literal('done'),
		done: z.literal(true),
		status_code: z.number(),
		context_id: z.string(),
	})
	.passthrough()

export const cartesiaErrorSchema = z
	.object({
		type: z.literal('error'),
		error: z.string().optional(),
		title: z.string().optional(),
		message: z.string().optional(),
		status_code: z.number().optional(),
		context_id: z.string().optional(),
	})
	.passthrough()

export const cartesiaFlushDoneSchema = z
	.object({
		type: z.literal('flush_done'),
		done: z.boolean(),
		flush_done: z.boolean(),
		flush_id: z.number(),
		status_code: z.number(),
		context_id: z.string(),
	})
	.passthrough()

export const cartesiaResponseSchema = z.union([
	cartesiaChunkSchema,
	cartesiaDoneSchema,
	cartesiaErrorSchema,
	cartesiaFlushDoneSchema,
])

export type CartesiaChunk = z.infer<typeof cartesiaChunkSchema>
export type CartesiaDone = z.infer<typeof cartesiaDoneSchema>
export type CartesiaError = z.infer<typeof cartesiaErrorSchema>
export type CartesiaResponse = z.infer<typeof cartesiaResponseSchema>

// ── Deepgram Flux ──────────────────────────────────────────────────

/**
 * Flux envelope types we care about. Unknown types are still accepted
 * (via passthrough) so the runtime doesn't crash on API additions, but
 * known types are explicitly enumerated so typos get caught.
 */
const fluxTypes = ['TurnInfo', 'Error', 'ConfigureSuccess', 'ConfigureFailure'] as const
const fluxEvents = ['Update', 'StartOfTurn', 'EndOfTurn', 'EagerEndOfTurn', 'TurnResumed'] as const

export type FluxType = (typeof fluxTypes)[number] | string
export type FluxEventName = (typeof fluxEvents)[number]

export const fluxEventSchema = z
	.object({
		type: z.enum(fluxTypes).or(z.string()),
		event: z.enum(fluxEvents).optional(),
		turn_index: z.number().optional(),
		transcript: z.string().optional(),
		end_of_turn_confidence: z.number().optional(),
		audio_window_start: z.number().optional(),
		audio_window_end: z.number().optional(),
		sequence_id: z.number().optional(),
		code: z.string().optional(),
		description: z.string().optional(),
		message: z.string().optional(),
		thresholds: z.record(z.string(), z.unknown()).optional(),
		keyterms: z.array(z.string()).optional(),
	})
	.passthrough()

export type FluxEvent = z.infer<typeof fluxEventSchema>

// ── Generic WS parser ──────────────────────────────────────────────

export type ParsedWebSocketMessage<T> =
	| {
			ok: true
			data: T
			text: string
	  }
	| {
			ok: false
			reason: 'invalid_json' | 'invalid_shape'
			error: Error
			text: string
	  }

/**
 * The shape of data delivered to a native WebSocket `message` handler
 * (plus `Buffer` for test fakes that pass Node Buffers directly). When
 * `binaryType = 'arraybuffer'` — which we set on every production socket —
 * binary frames arrive as `ArrayBuffer`.
 */
export type WebSocketRawData = ArrayBuffer | string | Buffer

function webSocketRawDataToText(raw: WebSocketRawData) {
	if (typeof raw === 'string') return raw
	if (Buffer.isBuffer(raw)) return raw.toString('utf8')
	return Buffer.from(raw).toString('utf8')
}

export function parseWebSocketJsonWithSchema<T extends ZodType>(
	raw: WebSocketRawData,
	schema: T,
): ParsedWebSocketMessage<z.infer<T>> {
	const text = webSocketRawDataToText(raw)
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error))
		return { ok: false, reason: 'invalid_json', error: err, text }
	}
	const result = schema.safeParse(parsed)
	if (!result.success) {
		return { ok: false, reason: 'invalid_shape', error: result.error, text }
	}
	return { ok: true, data: result.data, text }
}
