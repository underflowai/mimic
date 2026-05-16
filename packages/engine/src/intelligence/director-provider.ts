import OpenAI from 'openai'

import { config, type MimicDirectorProvider } from '#engine/config.js'

export interface ResolvedDirector {
	provider: MimicDirectorProvider
	client: OpenAI
	model: string
}

export async function resolveVoiceDirectorProvider(): Promise<ResolvedDirector> {
	const provider: MimicDirectorProvider = config.mimic.director.providerFromEnv

	switch (provider) {
		case 'openai':
			return {
				provider,
				client: new OpenAI({ apiKey: config.mimic.openai.apiKey }),
				model: config.mimic.director.openaiModel,
			}
		case 'anthropic':
			return {
				provider,
				client: new OpenAI({
					apiKey: config.mimic.anthropic.apiKey,
					baseURL: 'https://api.anthropic.com/v1/',
				}),
				model: config.mimic.director.anthropicModel,
			}
		default: {
			const _exhaustive: never = provider
			throw new Error(`Unknown director provider: ${_exhaustive}`)
		}
	}
}
