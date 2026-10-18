-- Never written by any code path: the only writer was the agents endpoint removed on 2026-05-15.
ALTER TABLE "api_agents" DROP COLUMN IF EXISTS "success_condition";
