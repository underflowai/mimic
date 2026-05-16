export type MimicDirectorProvider = 'openai' | 'anthropic'

const mimicCartesiaTtsModel = 'sonic-3.5'
const mimicCartesiaApiVersion = '2026-03-01'

const mimicFluxEotThreshold = 0.5
const mimicFluxEagerEotThreshold = 0.3
const mimicFluxEotTimeoutMs = 2000
const mimicFluxAudioChunkTargetMs = 80

export const config = {
	mimic: {
		director: {
			get providerFromEnv(): MimicDirectorProvider {
				const v = getEnv('MIMIC_DIRECTOR_PROVIDER', 'openai').toLowerCase()
				if (v === 'anthropic') return 'anthropic'
				return 'openai'
			},
			get openaiModel() {
				return getEnv('MIMIC_OPENAI_DIRECTOR_MODEL', 'gpt-5-chat-latest')
			},
			get anthropicModel() {
				return getEnv('MIMIC_ANTHROPIC_DIRECTOR_MODEL', 'claude-haiku-4-5')
			},
		},
		openai: {
			get apiKey() {
				return fetchEnv('OPENAI_API_KEY')
			},
		},
		anthropic: {
			get apiKey() {
				return fetchEnv('ANTHROPIC_API_KEY')
			},
		},
		cartesia: {
			get apiKey() {
				return fetchEnv('CARTESIA_API_KEY')
			},
			get ttsModel() {
				return mimicCartesiaTtsModel
			},
			get apiVersion() {
				return mimicCartesiaApiVersion
			},
		},
		deepgram: {
			get apiKey() {
				return fetchEnv('DEEPGRAM_API_KEY')
			},
		},
		flux: {
			get eotThreshold() {
				return mimicFluxEotThreshold
			},
			get eagerEotThreshold() {
				return mimicFluxEagerEotThreshold
			},
			get eotTimeoutMs() {
				return mimicFluxEotTimeoutMs
			},
			get audioChunkTargetMs() {
				return mimicFluxAudioChunkTargetMs
			},
		},
		backgroundModel: 'gpt-5.4-mini',
		searchModel: 'gpt-5.4-mini',
		substantiveSpeechMs: 350,
		yieldWindowMs: 80,
		ambience: {
			enabled: true,
			gain: 0.05,
		},
	},
	livekit: {
		get url() {
			return fetchEnv('LIVEKIT_URL')
		},
		get agentUrl() {
			return getEnv('LIVEKIT_AGENT_URL') ?? fetchEnv('LIVEKIT_URL')
		},
		get apiKey() {
			return fetchEnv('LIVEKIT_API_KEY')
		},
		get apiSecret() {
			return fetchEnv('LIVEKIT_API_SECRET')
		},
		sip: {
			get outboundTrunkId() {
				return fetchEnv('LIVEKIT_SIP_OUTBOUND_TRUNK_ID')
			},
		},
	},
}

function getEnv(key: string): string | undefined
function getEnv(key: string, defaultValue: string): string
function getEnv(key: string, defaultValue?: string) {
	return process.env[key] || defaultValue
}

function fetchEnv(key: string) {
	const value = process.env[key]
	if (!value) {
		throw new Error(`${key} environment variable is required`)
	}
	return value
}
