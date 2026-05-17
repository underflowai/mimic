/**
 * Voice Activity Detector
 *
 * Silero VAD v5 running locally via WebAssembly (onnxruntime-web) for fast
 * caller speech onset detection (~200ms). Triggers soft-pause instead of
 * waiting for Deepgram's StartOfTurn (~500ms).
 *
 * We use onnxruntime-web rather than onnxruntime-node because the native
 * package ships ~500 MB of GPU/CUDA provider binaries we don't use. The
 * WASM backend runs the 2 MB Silero model at <1 ms per 32 ms frame, which
 * is more than fast enough for a real-time voice pipeline.
 *
 * Uses standard Silero parameters matching Pipecat/LiveKit production
 * defaults. Echo cancellation is handled upstream by WebRTC (LiveKit).
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as ort from 'onnxruntime-web'

import { createLogger } from '#engine/logger.js'
import { convertPcm16BufferToFloat32Samples } from './audio-resample.js'

const log = createLogger('mimic:vad')

const MODEL_PATH = fileURLToPath(new URL('./silero_vad_v5.onnx', import.meta.url))

const SAMPLE_RATE = 16000
const FRAME_SAMPLES = 512
const POSITIVE_THRESHOLD = 0.5
const NEGATIVE_THRESHOLD = 0.35
const REDEMPTION_FRAMES = 8
const STATE_SHAPE: readonly [number, number, number] = [2, 1, 128]
const STATE_SIZE = 2 * 1 * 128

// Silero weights are stateless across calls; only the LSTM state tensor
// is per-instance. Share the compiled session across all VAD instances
// to avoid re-parsing the model (~230 ms cold start).
let sessionPromise: Promise<ort.InferenceSession> | null = null

function loadSession() {
	if (!sessionPromise) {
		sessionPromise = (async () => {
			const modelBuffer = await readFile(MODEL_PATH)
			return ort.InferenceSession.create(modelBuffer, {
				executionProviders: ['wasm'],
				graphOptimizationLevel: 'all',
			})
		})()
	}
	return sessionPromise
}

export interface VadConfig {
	onSpeechStart?: () => void
	onSpeechEnd?: () => void
}

function freshState(): ort.Tensor {
	return new ort.Tensor('float32', new Float32Array(STATE_SIZE), STATE_SHAPE)
}

export async function createVoiceActivityDetector(config?: VadConfig) {
	const session = await loadSession()
	const sr = new ort.Tensor('int64', [BigInt(SAMPLE_RATE)])
	let state: ort.Tensor = freshState()

	let active = true
	let speaking = false
	let redemptionCounter = 0
	let pending = new Float32Array(0)
	// Serialize inference so LSTM state updates remain sequential even if
	// the caller fires processAudio() multiple times in quick succession.
	let queue: Promise<void> = Promise.resolve()

	async function runFrame(frame: Float32Array) {
		const input = new ort.Tensor('float32', frame, [1, frame.length])
		const output = await session.run({ input, state, sr })
		state = output.stateN
		return (output.output.data as Float32Array)[0]
	}

	async function consumeFrames(samples: Float32Array) {
		if (!active) return
		const merged = new Float32Array(pending.length + samples.length)
		merged.set(pending)
		merged.set(samples, pending.length)

		let offset = 0
		while (merged.length - offset >= FRAME_SAMPLES) {
			const frame = merged.slice(offset, offset + FRAME_SAMPLES)
			offset += FRAME_SAMPLES

			const prob = await runFrame(frame)

			if (prob >= POSITIVE_THRESHOLD) {
				redemptionCounter = 0
				if (!speaking) {
					speaking = true
					log.info('speech detected')
					config?.onSpeechStart?.()
				}
			} else if (prob < NEGATIVE_THRESHOLD && speaking) {
				redemptionCounter++
				if (redemptionCounter >= REDEMPTION_FRAMES) {
					speaking = false
					redemptionCounter = 0
					log.info('speech ended')
					config?.onSpeechEnd?.()
				}
			}
		}
		pending = merged.slice(offset)
	}

	function processAudio(pcm16: Buffer) {
		if (!active) return
		const alignedPcm16 =
			pcm16.byteLength % 2 === 0 ? pcm16 : pcm16.subarray(0, Math.max(0, pcm16.byteLength - 1))
		if (alignedPcm16.byteLength === 0) return
		const samples = convertPcm16BufferToFloat32Samples(alignedPcm16)
		queue = queue
			.then(() => consumeFrames(samples))
			.catch((err: unknown) => {
				log.error({ err }, 'VAD processing failed')
			})
	}

	function destroy() {
		active = false
		speaking = false
		redemptionCounter = 0
		pending = new Float32Array(0)
		state = freshState()
	}

	log.info('Silero VAD v5 ready')
	return { processAudio, destroy }
}

export type VoiceActivityDetector = Awaited<ReturnType<typeof createVoiceActivityDetector>>
