import OpenAI from 'openai'

import { config, type MimicDirectorProvider } from '#engine/config.js'
import { models, type ReasoningEffort } from '#engine/models.js'

export interface ResolvedDirector {
	provider: MimicDirectorProvider
	client: OpenAI
	model: string
	/** Only set for OpenAI reasoning models; omitted for Anthropic and for caller-supplied models. */
	reasoningEffort?: ReasoningEffort
}

export interface DirectorProviderOptions {
	provider?: MimicDirectorProvider
	model?: string
	reasoningEffort?: ReasoningEffort
}

/**
 * Resolve the LLM client and model for the voice director.
 *
 * Provider and model can be passed explicitly (preferred) or fall back
 * to the provider default in config and the model registry.
 */
export async function resolveVoiceDirectorProvider(options?: DirectorProviderOptions): Promise<ResolvedDirector> {
	const provider = options?.provider ?? config.mimic.director.defaultProvider

	switch (provider) {
		case 'openai':
			return {
				provider,
				client: new OpenAI({ apiKey: config.mimic.openai.apiKey }),
				model: options?.model ?? models.director.openai.model,
				// A caller overriding the model owns the effort too; the default effort is tuned for the default model.
				reasoningEffort:
					options?.reasoningEffort ?? (options?.model ? undefined : models.director.openai.reasoningEffort),
			}
		case 'anthropic':
			return {
				provider,
				client: new OpenAI({
					apiKey: config.mimic.anthropic.apiKey,
					baseURL: 'https://api.anthropic.com/v1/',
				}),
				model: options?.model ?? models.director.anthropic.model,
			}
		default: {
			const _exhaustive: never = provider
			throw new Error(`Unknown director provider: ${_exhaustive}`)
		}
	}
}
