export interface OpenAIConfig {
	model: string
	maxTokens: number
	reasoningEffort?: 'none' | 'low' | 'medium' | 'high'
}

export type ModelConfigKey = 'helper' | 'webSearch' | 'toolWatcher'

export const modelConfig = {
	helper: {
		model: 'gpt-5.4',
		maxTokens: 20000,
		reasoningEffort: 'low' as const,
	},
	webSearch: {
		model: 'gpt-5.4',
		maxTokens: 20000,
		reasoningEffort: 'medium' as const,
	},
	toolWatcher: {
		model: 'gpt-5.5',
		maxTokens: 512,
		reasoningEffort: 'low' as const,
	},
} as const

export function getOpenAIConfig(key: ModelConfigKey): OpenAIConfig {
	return modelConfig[key]
}
