ALTER TABLE "api_calls" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "api_calls" ALTER COLUMN "created_at" SET DEFAULT now();