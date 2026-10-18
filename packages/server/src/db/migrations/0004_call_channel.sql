-- Web calls: the far end joins from a browser instead of being dialed, so a call may have no number.
ALTER TABLE "api_calls" ALTER COLUMN "to_phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_calls" ADD COLUMN IF NOT EXISTS "channel" text DEFAULT 'phone' NOT NULL;
