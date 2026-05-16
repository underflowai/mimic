import { execSync } from 'node:child_process'

import { AudioFrame, AudioSource, LocalAudioTrack } from '@livekit/rtc-node'

const SAMPLE_RATE = 48000
const CHANNELS = 1
const SAMPLES_PER_FRAME = (SAMPLE_RATE * 20) / 1000

export interface AmbienceTrackOptions {
	filePath: string
	gain?: number
}

function decodeToRawPcm(filePath: string): Buffer {
	return execSync(
		`ffmpeg -hide_banner -loglevel error -i "${filePath}" -f s16le -ac ${CHANNELS} -ar ${SAMPLE_RATE} -`,
		{
			maxBuffer: 100 * 1024 * 1024,
		},
	)
}

export function createAmbienceTrack(options: AmbienceTrackOptions) {
	const gain = options.gain ?? 0.02

	console.log(`[ambience] decoding ${options.filePath} (gain=${gain})`)
	const raw = decodeToRawPcm(options.filePath)
	const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2)

	for (let i = 0; i < samples.length; i++) {
		samples[i] = Math.round(samples[i] * gain)
	}
	console.log(`[ambience] decoded ${Math.round(samples.length / SAMPLE_RATE)}s`)

	const source = new AudioSource(SAMPLE_RATE, CHANNELS)
	const track = LocalAudioTrack.createAudioTrack('office-ambience', source)

	let running = false
	let offset = 0

	async function loop(signal: AbortSignal) {
		running = true
		while (running && !signal.aborted) {
			const end = offset + SAMPLES_PER_FRAME
			if (end > samples.length) {
				offset = 0
				continue
			}
			const frame = samples.subarray(offset, end)
			await source.captureFrame(new AudioFrame(new Int16Array(frame), SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME))
			offset = end
		}
	}

	function stop() {
		running = false
	}

	return { track, source, loop, stop }
}
