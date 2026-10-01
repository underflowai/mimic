/**
 * Backchannel Clip Loader
 *
 * Loads pre-generated backchannel audio clips from disk. These are raw
 * PCM16 mono files at `ttsSampleRate`, one per token per Cartesia voice,
 * generated once and committed to the repo. No network calls at runtime.
 *
 * Clips live in `audio/<ttsVoiceId>/<token>.pcm` so a persona's clips are
 * found by the same voice id the TTS speaker uses — there is no separate
 * voice-name mapping to keep in sync.
 *
 * Loading is fail-fast: if any token's file is missing or unreadable we
 * throw, rather than return a partially-populated map that would cause
 * silent UX degradation (the classifier could pick a token we can't
 * actually play).
 *
 * To (re)generate clips for a voice:
 *   cd packages/engine
 *   node --env-file=../../.env --import tsx scripts/generate-backchannel-clips.ts <ttsVoiceId>
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLogger } from '#engine/logger.js'

import { backchannelTokens, type BackchannelToken } from './tokens.js'

const log = createLogger('mimic:bc-clips')

const audioDir = fileURLToPath(new URL('./audio', import.meta.url))

export function clipFileName(token: BackchannelToken) {
	return `${token}.pcm`
}

const loadedClips = new Map<string, Promise<Map<BackchannelToken, Buffer>>>()

export function loadBackchannelClips(ttsVoiceId: string) {
	const existing = loadedClips.get(ttsVoiceId)
	if (existing) return existing

	const clipDir = join(audioDir, ttsVoiceId)
	const promise = (async () => {
		const clips = new Map<BackchannelToken, Buffer>()
		const missing: Array<{ token: BackchannelToken; file: string; err: unknown }> = []
		await Promise.all(
			backchannelTokens.map(async (token) => {
				const file = clipFileName(token)
				try {
					clips.set(token, await readFile(join(clipDir, file)))
				} catch (err) {
					missing.push({ token, file, err })
				}
			}),
		)

		if (missing.length > 0) {
			log.error({ ttsVoiceId, missing }, 'backchannel clips missing; refusing to partially load')
			loadedClips.delete(ttsVoiceId)
			throw new Error(
				`Missing backchannel clip assets for voice "${ttsVoiceId}": ${missing
					.map((m) => m.token)
					.join(', ')}. Run scripts/generate-backchannel-clips.ts ${ttsVoiceId}.`,
			)
		}

		log.info({ count: clips.size, ttsVoiceId }, 'backchannel clips loaded from disk')
		return clips
	})()

	loadedClips.set(ttsVoiceId, promise)
	return promise
}
