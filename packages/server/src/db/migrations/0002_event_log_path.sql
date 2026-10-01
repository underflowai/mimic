-- IF NOT EXISTS: production may already carry this column from an out-of-journal
-- `drizzle-kit push` (same situation as 0001_call_data); a plain ADD COLUMN
-- would crash the boot migration.
ALTER TABLE "api_calls" ADD COLUMN IF NOT EXISTS "event_log_path" text;
