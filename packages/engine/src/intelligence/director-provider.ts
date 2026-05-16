import OpenAI from 'openai'

import { config, type MimicDirectorProvider } from '#engine/config.js'

export interface ResolvedDirector {
	provider: MimicDirectorProvider
	client: OpenAI
	model: string
}

export interface DirectorProviderOptions {
	provider?: MimicDirectorProvider
	model?: string
}

/**
 * Resolve the LLM client and model for the voice director.
 *
 * Provider and model can be passed explicitly (preferred) or fall back
 * to defaults in config.
 */
export async function resolveVoiceDirectorProvider(options?: DirectorProviderOptions): Promise<ResolvedDirector> {
	const provider = options?.provider ?? config.mimic.director.defaultProvider

	switch (provider) {
		case 'openai':
			return {
				provider,
				client: new OpenAI({ apiKey: config.mimic.openai.apiKey }),
				model: options?.model ?? config.mimic.director.defaultOpenaiModel,
			}
		case 'anthropic':
			return {
				provider,
				client: new OpenAI({
					apiKey: config.mimic.anthropic.apiKey,
					baseURL: 'https://api.anthropic.com/v1/',
				}),
				model: options?.model ?? config.mimic.director.defaultAnthropicModel,
			}
		default: {
			const _exhaustive: never = provider
			throw new Error(`Unknown director provider: ${_exhaustive}`)
		}
	}
}
