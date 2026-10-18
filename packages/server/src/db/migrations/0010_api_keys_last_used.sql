ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "tenant_id";
