import type { ToolDefinition } from './runner.js'

export const webSearchToolDefinition = {
	name: 'webSearch',
	description:
		'Look up real-world facts the agent does not already know — industry statistics, company background, regulatory details, market data. Do not search for information already provided in context.',
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
