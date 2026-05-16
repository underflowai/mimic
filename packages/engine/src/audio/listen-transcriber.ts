/**
 * Lightweight listen-only transcriber for passive audio monitoring.
 *
 * Wraps createDeepgramTranscriber to accumulate caller turns without
 * any TTS or director LLM. Used by listen mode where a broker's phone
 * call is transcribed in real time for field extraction.
 */

import { EventEmitter } from 'node:events'

import { createLogger } from '#engine/logger.js'

import type { CallTurn } from '../shared/prompt-turns.js'
import { createDeepgramTranscriber, type DeepgramTranscriberConfig } from './deepgram-transcriber.js'

const log = createLogger('mimic:listen')

type ListenTranscriberEvents = {
	turnComplete: [turns: CallTurn[], latestTurn: CallTurn]
	error: [message: string]
}

export function createListenTranscriber(opts?: DeepgramTranscriberConfig) {
	const transcriber = createDeepgramTranscriber(opts)
	const emitter = new EventEmitter<ListenTranscriberEvents>()
	const turns: CallTurn[] = []
	let startedAt: number | null = null

	transcriber.on('turnComplete', (transcript) => {
		const turn: CallTurn = { role: 'user', content: transcript }
		turns.push(turn)
		emitter.emit('turnComplete', turns, turn)
	})

	transcriber.on('error', (message) => {
		log.error({ message }, 'Deepgram error')
		emitter.emit('error', message)
	})

	async function connect() {
		turns.length = 0
		startedAt = Date.now()
		await transcriber.connect()
	}

	function listTurns() {
		return [...turns]
	}

	function getDurationSeconds() {
		if (!startedAt) return 0
		return Math.round((Date.now() - startedAt) / 1000)
	}

	async function close() {
		await transcriber.close()
	}

	return {
		connect,
		sendAudio: transcriber.sendAudio,
		configure: transcriber.configure,
		on: emitter.on.bind(emitter) as typeof emitter.on,
		off: emitter.off.bind(emitter) as typeof emitter.off,
		listTurns,
		getDurationSeconds,
		close,
	}
}

export type ListenTranscriber = ReturnType<typeof createListenTranscriber>
