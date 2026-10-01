ALTER TABLE "api_agents" ADD COLUMN IF NOT EXISTS "agent_spec" jsonb;--> statement-breakpoint
ALTER TABLE "api_agents" ADD COLUMN IF NOT EXISTS "evals" jsonb;--> statement-breakpoint
ALTER TABLE "api_calls" ADD COLUMN IF NOT EXISTS "tool_audit" jsonb;