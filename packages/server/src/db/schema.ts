import {
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core'

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

export const CALL_CHANNELS = ['phone', 'web'] as const
export type CallChannel = (typeof CALL_CHANNELS)[number]

export const apiAgents = pgTable('api_agents', {
	id: uuid('id').primaryKey().defaultRandom(),
	apiKeyId: uuid('api_key_id')
		.notNull()
		.references(() => apiKeys.id),
	name: text('name').notNull(),
	goal: text('goal').notNull(),
	voice: voiceEnum('voice').notNull().default('female'),
	context: jsonb('context').notNull().default({}),
	tools: jsonb('tools').notNull().default([]),
	systemPrompt: text('system_prompt').notNull(),
	turnControlBlock: text('turn_control_block'),
	agentName: text('agent_name').notNull(),
	configHash: text('config_hash'),
	ambience: jsonb('ambience'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const apiCalls = pgTable(
	'api_calls',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		apiKeyId: uuid('api_key_id')
			.notNull()
			.references(() => apiKeys.id),
		agentId: uuid('agent_id')
			.notNull()
			.references(() => apiAgents.id),
		/** How the far end joins: dialed over SIP, or a browser connecting with a join token. */
		channel: text('channel').$type<CallChannel>().notNull().default('phone'),
		/** E.164 number for phone calls; null for web calls. */
		toPhone: text('to_phone'),
		status: callStatusEnum('status').notNull().default('pending'),
		callContext: jsonb('call_context').notNull().default({}),
		/** Per-call `data` values, appended to the agent's prompt at runtime. */
		callData: jsonb('call_data'),
		/** Per-call `extract` fields: shown to the agent at runtime, filled in by the extractor afterward. */
		results: jsonb('results').notNull().default({}),
		transcript: jsonb('transcript'),
		toolCalls: jsonb('tool_calls'),
		result: jsonb('result'),
		goalAchieved: boolean('goal_achieved'),
		goalAchievedReason: text('goal_achieved_reason'),
		duration: integer('duration'),
		errorMessage: text('error_message'),
		recordingPath: text('recording_path'),
		/** S3 key of the per-call engine event log (`call-events/<id>.jsonl`), when one was persisted. */
		eventLogPath: text('event_log_path'),
		idempotencyKey: text('idempotency_key'),
		/** Where to POST `call.completed` / `call.failed` when this call ends. Per call: changing it never touches the agent. */
		webhookUrl: text('webhook_url'),
		/** HMAC key for the webhook signature, when the caller wants one. */
		webhookSecret: text('webhook_secret'),
		webhookDeliveredAt: timestamp('webhook_delivered_at', { withTimezone: true }),
		/** Millisecond precision so a value that went through a JS Date (the list cursor) matches the row exactly. */
		createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		idempotencyPerKeyUnique: uniqueIndex('api_calls_api_key_id_idempotency_key_unique').on(
			table.apiKeyId,
			table.idempotencyKey,
		),
		/** GET /calls pages newest-first per key; the btree is read backwards. */
		listByKey: index('api_calls_api_key_id_created_at_id_idx').on(table.apiKeyId, table.createdAt, table.id),
	}),
)

export type ApiKeyRow = typeof apiKeys.$inferSelect
export type ApiAgentRow = typeof apiAgents.$inferSelect
export type ApiCallRow = typeof apiCalls.$inferSelect
