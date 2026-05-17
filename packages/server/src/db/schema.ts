import { boolean, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const apiKeyStatusEnum = pgEnum('api_key_status', ['active', 'revoked'])

export const apiKeys = pgTable('api_keys', {
	id: uuid('id').primaryKey().defaultRandom(),
	keyHash: text('key_hash').notNull().unique(),
	keyPrefix: text('key_prefix').notNull(),
	name: text('name').notNull(),
	status: apiKeyStatusEnum('status').notNull().default('active'),
	tenantId: text('tenant_id'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const voiceEnum = pgEnum('voice', ['female', 'male'])
export const callStatusEnum = pgEnum('call_status', ['pending', 'in_progress', 'completed', 'failed', 'cancelled'])

export const apiAgents = pgTable('api_agents', {
	id: uuid('id').primaryKey().defaultRandom(),
	apiKeyId: uuid('api_key_id').notNull().references(() => apiKeys.id),
	name: text('name').notNull(),
	goal: text('goal').notNull(),
	voice: voiceEnum('voice').notNull().default('female'),
	context: jsonb('context').notNull().default({}),
	tools: jsonb('tools').notNull().default([]),
	results: jsonb('results').notNull().default({}),
	systemPrompt: text('system_prompt').notNull(),
	turnControlBlock: text('turn_control_block'),
	agentName: text('agent_name').notNull(),
	configHash: text('config_hash'),
	webhook: text('webhook'),
	successCondition: jsonb('success_condition'),
	ambience: jsonb('ambience'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const apiCalls = pgTable(
	'api_calls',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		apiKeyId: uuid('api_key_id').notNull().references(() => apiKeys.id),
		agentId: uuid('agent_id').notNull().references(() => apiAgents.id),
		toPhone: text('to_phone').notNull(),
		status: callStatusEnum('status').notNull().default('pending'),
		callContext: jsonb('call_context').notNull().default({}),
		transcript: jsonb('transcript'),
		toolCalls: jsonb('tool_calls'),
		result: jsonb('result'),
		goalAchieved: boolean('goal_achieved'),
		goalAchievedReason: text('goal_achieved_reason'),
		duration: integer('duration'),
		errorMessage: text('error_message'),
		recordingPath: text('recording_path'),
		idempotencyKey: text('idempotency_key'),
		webhookDeliveredAt: timestamp('webhook_delivered_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		idempotencyPerKeyUnique: uniqueIndex('api_calls_api_key_id_idempotency_key_unique').on(
			table.apiKeyId,
			table.idempotencyKey,
		),
	}),
)

export type ApiKeyRow = typeof apiKeys.$inferSelect
export type ApiAgentRow = typeof apiAgents.$inferSelect
export type ApiCallRow = typeof apiCalls.$inferSelect
