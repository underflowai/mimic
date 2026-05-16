export function convertPcm16BufferToFloat32Samples(pcm16: Buffer) {
	if (pcm16.length % 2 !== 0) {
		throw new RangeError(`PCM16 buffer length must be even; got ${pcm16.length} bytes`)
	}
	const samples = new Float32Array(pcm16.length / 2)
	for (let i = 0; i < samples.length; i++) {
		samples[i] = pcm16.readInt16LE(i * 2) / 32768
	}
	return samples
}

export function resampleFloat32LinearSamples(input: Float32Array, sourceSampleRate: number, targetSampleRate: number) {
	if (sourceSampleRate <= 0 || targetSampleRate <= 0) {
		throw new RangeError(`Sample rates must be positive; got source=${sourceSampleRate}, target=${targetSampleRate}`)
	}
	if (input.length === 0) return new Float32Array(0)
	if (sourceSampleRate === targetSampleRate) return input.slice()

	const outputLength = Math.floor((input.length * targetSampleRate) / sourceSampleRate)
	if (outputLength <= 0) return new Float32Array(0)
	const output = new Float32Array(outputLength)

	for (let i = 0; i < outputLength; i++) {
		const sourcePosition = (i * sourceSampleRate) / targetSampleRate
		const sourceIndex = Math.floor(sourcePosition)
		const fraction = sourcePosition - sourceIndex

		if (sourceIndex + 1 < input.length) {
			output[i] = input[sourceIndex] + fraction * (input[sourceIndex + 1] - input[sourceIndex])
		} else {
			output[i] = input[sourceIndex] ?? 0
		}
	}

	return output
}

export function resamplePcm16BufferToFloat32Samples(pcm16: Buffer, sourceSampleRate: number, targetSampleRate: number) {
	const input = convertPcm16BufferToFloat32Samples(pcm16)
	return resampleFloat32LinearSamples(input, sourceSampleRate, targetSampleRate)
}
