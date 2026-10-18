-- Extract fields belong to the call, not the compiled agent: one agent now serves calls that want different things back.
ALTER TABLE "api_calls" ADD COLUMN IF NOT EXISTS "results" jsonb;
