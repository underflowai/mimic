/** TTS output format — Cartesia sends 48kHz s16le mono PCM (pcm_s16le). */
export const ttsSampleRate = 48000
export const ttsBytesPerSample = 2
export const ttsBytesPerMs = (ttsSampleRate * ttsBytesPerSample) / 1000 // 96
export const ttsFrameMs = 20
export const ttsFrameBytes = ttsBytesPerMs * ttsFrameMs // 1920

export const avgMsPerWord = 400 // ~150 wpm — used for partial-playback estimation
export const maxChunkBytes = 1920 // 20ms at 48kHz PCM
export const progressMarkIntervalBytes = 48000 // ~500ms at 48kHz PCM
export const interruptDrainMs = 200 // audio tail after interrupt — matches Levelt stop latency (150-200ms)
export const interruptFadeMs = 50 // linear fade applied to the drain tail

export function estimateHeardPortion(draft: string, sentMs: number, confirmedWords: number) {
	if (!draft || sentMs <= 0) return ''
	const words = draft.split(/\s+/).filter(Boolean)
	const wordsHeard =
		confirmedWords > 0
			? Math.min(confirmedWords, words.length)
			: Math.min(Math.floor(sentMs / avgMsPerWord), words.length)
	const rawPortion = words.slice(0, wordsHeard).join(' ')
	const boundaryMatch = rawPortion.match(/^(.*[.!?,;—])\s*/s)
	return boundaryMatch ? boundaryMatch[1] : rawPortion
}

export function applyLinearFade(buf: Buffer, fadeMs: number) {
	const fadeSamples = Math.round((ttsSampleRate * fadeMs) / 1000)
	const fadeBytes = fadeSamples * ttsBytesPerSample
	if (buf.length < fadeBytes) return buf
	const out = Buffer.from(buf)
	const startOffset = out.length - fadeBytes
	for (let i = 0; i < fadeSamples; i++) {
		const pos = startOffset + i * 2
		if (pos + 1 >= out.length) break
		const sample = out.readInt16LE(pos)
		out.writeInt16LE(Math.round(sample * (1 - (i + 1) / fadeSamples)), pos)
	}
	return out
}
