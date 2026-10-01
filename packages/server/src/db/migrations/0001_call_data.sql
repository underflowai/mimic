-- IF NOT EXISTS: production already carried this column from an earlier
-- drizzle-kit push that predates the migration journal.
ALTER TABLE "api_calls" ADD COLUMN IF NOT EXISTS "call_data" jsonb;