/**
 * Backchannel Clip Loader
 *
 * Loads pre-generated backchannel audio clips from disk. These are static
 * PCM16 48kHz mono WAV files, generated once and committed to the repo.
 * No network calls at runtime.
 *
 * Loading is fail-fast: if any token's file is missing or unreadable we
 * throw, rather than return a partially-populated map that would cause
 * silent UX degradation (the classifier could pick a token we can't
 * actually play).
 *
 * To regenerate clips, run:
 *   cd libs/core
 *   pnpm exec tsx scripts/generate-backchannel-clips.ts
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLogger } from '#engine/logger.js'

import type { BackchannelToken } from './engine.js'

const log = createLogger('mimic:bc-clips')

const audioDir = fileURLToPath(new URL('./audio', import.meta.url))

function clipDirForVoice(ttsVoiceId: string) {
	return join(audioDir, ttsVoiceId)
}

const clipFiles: Record<BackchannelToken, string> = {
	'mm-hmm': 'mm-hmm.pcm',
	right: 'right.pcm',
	yeah: 'yeah.pcm',
	'got-it': 'got-it.pcm',
	okay: 'okay.pcm',
	'uh-huh': 'uh-huh.pcm',
	sure: 'sure.pcm',
	'i-see': 'i-see.pcm',
}

const loadedClips = new Map<string, Promise<Map<BackchannelToken, Buffer>>>()

export function loadBackchannelClips(ttsVoiceId = 'Sarah') {
	const existing = loadedClips.get(ttsVoiceId)
	if (existing) return existing

	const clipDir = clipDirForVoice(ttsVoiceId)
	const promise = (async () => {
		const clips = new Map<BackchannelToken, Buffer>()
		const entries = Object.entries(clipFiles) as [BackchannelToken, string][]

		const missing: Array<{ token: BackchannelToken; file: string; err: unknown }> = []
		await Promise.all(
			entries.map(async ([token, file]) => {
				try {
					const buf = await readFile(join(clipDir, file))
					clips.set(token, buf)
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
					.join(', ')}. Run scripts/generate-backchannel-clips.ts.`,
			)
		}

		log.info({ count: clips.size, ttsVoiceId }, 'backchannel clips loaded from disk')
		return clips
	})()

	loadedClips.set(ttsVoiceId, promise)
	return promise
}
