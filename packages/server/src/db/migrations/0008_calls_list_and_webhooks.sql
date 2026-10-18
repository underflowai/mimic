-- The webhook belongs to the call, not the agent: changing where a result is posted must not create
-- (and recompile) another agent. Defensive forms because production predates the journal.
ALTER TABLE "api_calls" ADD COLUMN IF NOT EXISTS "webhook_url" text;--> statement-breakpoint
ALTER TABLE "api_calls" ADD COLUMN IF NOT EXISTS "webhook_secret" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_calls_api_key_id_created_at_id_idx" ON "api_calls" USING btree ("api_key_id","created_at","id");--> statement-breakpoint
ALTER TABLE "api_agents" DROP COLUMN IF EXISTS "webhook";
