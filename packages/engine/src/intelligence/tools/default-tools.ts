import type { ToolDefinition } from './runner.js'

export const webSearchToolDefinition = {
	name: 'webSearch',
	description:
		'Research the specific external fact the caller needs, especially current or time-sensitive information. Include the intended entity, location, and time window when known. Do not research a company merely because it was mentioned, add sales context, or repeat facts already verified for the relevant time window.',
	kind: 'read',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'The search query' },
		},
		required: ['query'],
	},
} satisfies ToolDefinition

export const defaultMimicTools = [webSearchToolDefinition] satisfies ToolDefinition[]
