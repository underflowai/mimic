-- What a call wants back lives on the call, always: an empty spec is `{}`, never NULL.
-- Rows older than 0005 are NULL and must be filled before the constraint lands.
ALTER TABLE "api_calls" ALTER COLUMN "results" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
UPDATE "api_calls" SET "results" = '{}'::jsonb WHERE "results" IS NULL;--> statement-breakpoint
ALTER TABLE "api_calls" ALTER COLUMN "results" SET NOT NULL;--> statement-breakpoint
-- The agent row no longer carries extract fields; nothing reads this column.
ALTER TABLE "api_agents" DROP COLUMN IF EXISTS "results";
