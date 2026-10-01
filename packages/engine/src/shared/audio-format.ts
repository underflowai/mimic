/**
 * PCM formats at the two edges of the engine.
 *
 * Everything that touches raw audio derives from these values. Change them
 * here and the transport, VAD, Deepgram URL, Cartesia request, and pacing
 * math all follow.
 */

/** 16-bit signed little-endian PCM — the only sample format the engine handles. */
export const pcm16BytesPerSample = 2

// ── Caller audio in (ASR) ────────────────────────────────────────────
// Silero VAD v5 and Deepgram Flux both consume 16 kHz mono PCM16.

export const asrSampleRate = 16_000
export const asrEncoding = 'linear16' as const
export const asrBytesPerMs = (asrSampleRate * pcm16BytesPerSample) / 1000

// ── Agent audio out (TTS) ────────────────────────────────────────────
// Cartesia renders 48 kHz mono PCM16; the transport plays it in 20 ms frames.

export const ttsSampleRate = 48_000
export const ttsBytesPerSample = pcm16BytesPerSample
export const ttsBytesPerMs = (ttsSampleRate * ttsBytesPerSample) / 1000
export const ttsFrameMs = 20
export const ttsFrameBytes = ttsBytesPerMs * ttsFrameMs

/** Duration of a TTS PCM buffer in milliseconds. */
export function ttsBytesToMs(bytes: number): number {
	return bytes / ttsBytesPerMs
}

/** Sample-aligned byte length of `ms` of TTS PCM. */
export function ttsMsToBytes(ms: number): number {
	return Math.round((ms * ttsSampleRate) / 1000) * ttsBytesPerSample
}
