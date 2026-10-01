/**
 * Runtime configuration.
 *
 * Secrets and deployment-specific values come from the environment. Tuning
 * knobs that an operator may reasonably want to change without a deploy
 * (Flux model and thresholds, turn-taking windows) are env-overridable with
 * validated defaults. Everything else is a plain, documented constant.
 *
 * Model names live in `models.ts`.
 */

export type MimicDirectorProvider = 'openai' | 'anthropic'

function parseDirectorProvider(raw: string | undefined): MimicDirectorProvider {
	if (!raw) return 'openai'
	const normalized = raw.trim().toLowerCase()
	if (normalized === 'openai' || normalized === 'anthropic') return normalized
	throw new Error(`MIMIC_DIRECTOR_PROVIDER must be "openai" or "anthropic" (received "${raw}")`)
}

export const config = {
	mimic: {
		director: {
			get defaultProvider(): MimicDirectorProvider {
				return parseDirectorProvider(getEnv('MIMIC_DIRECTOR_PROVIDER'))
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
			ttsModel: 'sonic-3.6',
			apiVersion: '2026-03-01',
		},
		deepgram: {
			get apiKey() {
				return fetchEnv('DEEPGRAM_API_KEY')
			},
		},
		/** Deepgram Flux (`/v2/listen`) connection parameters. */
		flux: {
			get model() {
				return getEnv('MIMIC_FLUX_MODEL', 'flux-general-en')
			},
			/** End-of-turn confidence that commits a turn. */
			get eotThreshold() {
				return getNumberEnv('MIMIC_FLUX_EOT_THRESHOLD', 0.7, { min: 0.5, max: 0.9 })
			},
			/** Lower confidence at which Flux emits EagerEndOfTurn so we can speculate. */
			get eagerEotThreshold() {
				return getNumberEnv('MIMIC_FLUX_EAGER_EOT_THRESHOLD', 0.3, { min: 0.3, max: 0.9 })
			},
			/** Silence after which Flux forces EndOfTurn regardless of confidence. */
			get eotTimeoutMs() {
				return getNumberEnv('MIMIC_FLUX_EOT_TIMEOUT_MS', 3000, { min: 500, max: 60_000, integer: true })
			},
			/**
			 * Stricter endpointing used for one caller turn after the agent asks for
			 * a value that is read out in pieces (email, phone, spelling). Flux
			 * otherwise commits "john dot" as a complete turn.
			 */
			get carefulEotThreshold() {
				return getNumberEnv('MIMIC_FLUX_CAREFUL_EOT_THRESHOLD', 0.85, { min: 0.5, max: 0.9 })
			},
			get carefulEotTimeoutMs() {
				return getNumberEnv('MIMIC_FLUX_CAREFUL_EOT_TIMEOUT_MS', 5000, { min: 500, max: 60_000, integer: true })
			},
			/**
			 * Below this end-of-turn confidence a caller turn is treated as
			 * trailing off rather than finished: no eager speculation is started
			 * for it, and a timeout-forced final gets a "the caller may not be
			 * done" hint in the control block instead of reusing an eager draft.
			 */
			get lowConfidenceEot() {
				return getNumberEnv('MIMIC_LOW_CONFIDENCE_EOT', 0.35, { min: 0, max: 0.9 })
			},
			/** Caller audio is batched into chunks of about this length before sending. */
			audioChunkTargetMs: 80,
			reconnect: {
				maxAttempts: 5,
				initialBackoffMs: 500,
				maxBackoffMs: 10_000,
			},
		},
		/** Turn-taking windows. */
		turnTaking: {
			/** Caller speech shorter than this while the agent talks is treated as a backchannel, not a barge. */
			get substantiveSpeechMs() {
				return getNumberEnv('MIMIC_SUBSTANTIVE_SPEECH_MS', 350, { min: 0, max: 5000, integer: true })
			},
			/** Grace window after a soft pause before the agent resumes. */
			get yieldWindowMs() {
				return getNumberEnv('MIMIC_YIELD_WINDOW_MS', 80, { min: 0, max: 2000, integer: true })
			},
			/**
			 * Extra time a soft pause waits for the transcriber to confirm speech
			 * when `substantiveSpeechMs` elapses on VAD alone. Noise and breaths
			 * trip VAD without ever producing words; this keeps them from
			 * interrupting the agent while still yielding to a caller whose words
			 * Flux is slow to report.
			 */
			get vadOnlyGraceMs() {
				return getNumberEnv('MIMIC_VAD_ONLY_GRACE_MS', 500, { min: 0, max: 5000, integer: true })
			},
			/**
			 * Speak a short filler ("Hmm.", "Let me see.") on a fresh turn when the
			 * model's first token has not arrived by this deadline. 0 disables it.
			 */
			get latencyFillerMs() {
				return getNumberEnv('MIMIC_LATENCY_FILLER_MS', 1000, { min: 0, max: 10_000, integer: true })
			},
			/** Caller silence before the agent prompts with a follow-up. */
			silenceIdleMs: 6_000,
			/** Silence allowed while the caller asked us to hold ("one sec, let me grab my calendar"). */
			get holdIdleMs() {
				return getNumberEnv('MIMIC_HOLD_IDLE_MS', 45_000, { min: 1000, max: 300_000, integer: true })
			},
			/** Follow-up prompts before the agent closes the call. */
			maxSilenceFollowUps: 3,
		},
		/** Deadlines for external systems. */
		timeouts: {
			websocketOpenMs: 10_000,
			transcriberConfigureAckMs: 2_000,
			transcriberCloseHandshakeMs: 2_000,
			/** No audio from Cartesia for this long after text is sent → give up on the synthesis. */
			ttsSynthesisWatchdogMs: 12_000,
			/** Transport never confirmed playout of the final frame → commit the turn anyway. */
			playbackConfirmMs: 5_000,
			toolWatcherMs: 8_000,
			toolExecutionMs: 30_000,
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

interface NumberEnvBounds {
	min?: number
	max?: number
	integer?: boolean
}

export function getNumberEnv(key: string, defaultValue: number, bounds: NumberEnvBounds = {}): number {
	const raw = process.env[key]
	if (raw === undefined || raw.trim() === '') return defaultValue
	const value = Number(raw)
	const valid =
		Number.isFinite(value) &&
		(bounds.integer !== true || Number.isInteger(value)) &&
		(bounds.min === undefined || value >= bounds.min) &&
		(bounds.max === undefined || value <= bounds.max)
	if (!valid) {
		const constraint = [
			bounds.integer ? 'an integer' : 'a number',
			bounds.min !== undefined ? `>= ${bounds.min}` : null,
			bounds.max !== undefined ? `<= ${bounds.max}` : null,
		]
			.filter(Boolean)
			.join(' ')
		throw new Error(`${key} must be ${constraint} (received "${raw}")`)
	}
	return value
}
