/**
 * Generate backchannel clips for one or more Cartesia voices.
 *
 *   cd packages/engine
 *   node --conditions=source --env-file=../../.env --import tsx \
 *     scripts/generate-backchannel-clips.ts <ttsVoiceId> [<ttsVoiceId> ...]
 *
 * Writes `src/backchannel/audio/<ttsVoiceId>/<token>.pcm` for every token in
 * `backchannelTokens`: raw PCM16 mono at `ttsSampleRate`, trimmed of
 * leading/trailing silence, with a short fade at both ends. Uses the same
 * model and API version as the live TTS speaker so clips match the voice.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { backchannelTokens, type BackchannelToken } from '../src/backchannel/tokens.js'
import { clipFileName } from '../src/backchannel/clips.js'
import { config } from '../src/config.js'
import { pcm16BytesPerSample, ttsSampleRate } from '../src/shared/audio-format.js'
import { applyLinearFade } from '../src/shared/audio-pacing.js'

const transcripts: Record<BackchannelToken, string> = {
	'mm-hmm': 'Mm-hmm.',
	'uh-huh': 'Uh-huh.',
	yeah: 'Yeah.',
	right: 'Right.',
	sure: 'Sure.',
	'got-it': 'Got it.',
	'i-see': 'I see.',
	okay: 'Okay.',
}

/** Samples below this absolute amplitude count as silence (~1.5% of full scale). */
const silenceThreshold = 500
const paddingMs = 30
const fadeMs = 10

const audioDir = resolve(import.meta.dirname, '../src/backchannel/audio')

async function synthesize(voiceId: string, transcript: string): Promise<Buffer> {
	const response = await fetch('https://api.cartesia.ai/tts/bytes', {
		method: 'POST',
		headers: {
			'X-API-Key': config.mimic.cartesia.apiKey,
			'Cartesia-Version': config.mimic.cartesia.apiVersion,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model_id: config.mimic.cartesia.ttsModel,
			transcript,
			voice: { mode: 'id', id: voiceId },
			output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: ttsSampleRate },
			language: 'en',
		}),
	})
	if (!response.ok) {
		throw new Error(`Cartesia ${response.status} for "${transcript}": ${await response.text()}`)
	}
	return Buffer.from(await response.arrayBuffer())
}

function trimSilence(pcm: Buffer): Buffer {
	const sampleCount = Math.floor(pcm.length / pcm16BytesPerSample)
	let first = 0
	while (first < sampleCount && Math.abs(pcm.readInt16LE(first * pcm16BytesPerSample)) < silenceThreshold) first++
	let last = sampleCount - 1
	while (last > first && Math.abs(pcm.readInt16LE(last * pcm16BytesPerSample)) < silenceThreshold) last--
	if (first >= last) return pcm

	const padding = Math.round((ttsSampleRate * paddingMs) / 1000)
	const start = Math.max(0, first - padding)
	const end = Math.min(sampleCount, last + 1 + padding)
	return pcm.subarray(start * pcm16BytesPerSample, end * pcm16BytesPerSample)
}

function fadeIn(pcm: Buffer): Buffer {
	const fadeSamples = Math.round((ttsSampleRate * fadeMs) / 1000)
	const out = Buffer.from(pcm)
	for (let i = 0; i < fadeSamples && i * pcm16BytesPerSample + 1 < out.length; i++) {
		const pos = i * pcm16BytesPerSample
		out.writeInt16LE(Math.round(out.readInt16LE(pos) * ((i + 1) / fadeSamples)), pos)
	}
	return out
}

async function generateVoice(voiceId: string) {
	const dir = join(audioDir, voiceId)
	await mkdir(dir, { recursive: true })
	for (const token of backchannelTokens) {
		const raw = await synthesize(voiceId, transcripts[token])
		const clip = applyLinearFade(fadeIn(trimSilence(raw)), fadeMs)
		await writeFile(join(dir, clipFileName(token)), clip)
		const ms = Math.round(clip.length / ((ttsSampleRate * pcm16BytesPerSample) / 1000))
		console.log(`${voiceId}/${clipFileName(token)}  ${clip.length} bytes (${ms} ms, trimmed from ${raw.length})`)
	}
}

const voiceIds = process.argv.slice(2)
if (voiceIds.length === 0) {
	console.error('usage: generate-backchannel-clips.ts <ttsVoiceId> [<ttsVoiceId> ...]')
	process.exit(1)
}
for (const voiceId of voiceIds) await generateVoice(voiceId)
