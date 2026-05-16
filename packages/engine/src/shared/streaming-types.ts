export type DirectorStreamEvent = { type: 'token'; value: string }

export interface EagerAudioSink {
	chunks: Buffer[]
	done: boolean
	forward: ((chunk: Buffer) => void) | null
	ttsPromise?: Promise<void>
}
