CREATE TYPE "public"."api_key_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."call_status" AS ENUM('pending', 'in_progress', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."voice" AS ENUM('female', 'male');--> statement-breakpoint
CREATE TABLE "api_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid NOT NULL,
	"name" text NOT NULL,
	"goal" text NOT NULL,
	"voice" "voice" DEFAULT 'female' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"system_prompt" text NOT NULL,
	"turn_control_block" text,
	"agent_name" text NOT NULL,
	"config_hash" text,
	"webhook" text,
	"success_condition" jsonb,
	"ambience" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"to_phone" text NOT NULL,
	"status" "call_status" DEFAULT 'pending' NOT NULL,
	"call_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transcript" jsonb,
	"tool_calls" jsonb,
	"result" jsonb,
	"goal_achieved" boolean,
	"goal_achieved_reason" text,
	"duration" integer,
	"error_message" text,
	"recording_path" text,
	"idempotency_key" text,
	"webhook_delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"name" text NOT NULL,
	"status" "api_key_status" DEFAULT 'active' NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "api_agents" ADD CONSTRAINT "api_agents_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_agent_id_api_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."api_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_calls_api_key_id_idempotency_key_unique" ON "api_calls" USING btree ("api_key_id","idempotency_key");