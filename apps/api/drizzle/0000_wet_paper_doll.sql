CREATE TYPE "public"."api_key_environment" AS ENUM('live', 'test');--> statement-breakpoint
CREATE TYPE "public"."ask_frequency" AS ENUM('after_7_days', 'after_30_days', 'after_60_days');--> statement-breakpoint
CREATE TYPE "public"."console_user_role" AS ENUM('admin', 'editor');--> statement-breakpoint
CREATE TYPE "public"."device_auth_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "public"."last_action" AS ENUM('dismissed', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."metric_type" AS ENUM('CSAT', 'CES');--> statement-breakpoint
CREATE TYPE "public"."on_positive_action" AS ENUM('none', 'play_store_review');--> statement-breakpoint
CREATE TYPE "public"."rating_type" AS ENUM('star', 'emoji', 'effort_scale');--> statement-breakpoint
CREATE TYPE "public"."workflow_managed_by" AS ENUM('console', 'code');--> statement-breakpoint
CREATE TYPE "public"."workflow_status" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"environment" "api_key_environment" NOT NULL,
	"allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cli_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"name" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "console_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" "console_user_role" DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "console_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "device_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"account_id" uuid,
	"status" "device_auth_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"trigger_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"event_name" text NOT NULL,
	"context" text,
	"rating_value" integer NOT NULL,
	"chip_selected" text,
	"other_text" text,
	"other_image_url" text,
	"location" jsonb,
	"device_os" text NOT NULL,
	"app_version" text NOT NULL,
	"session_age_days" integer,
	"shown_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seen_events" (
	"account_id" uuid NOT NULL,
	"event_name" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hit_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "seen_events_account_id_event_name_pk" PRIMARY KEY("account_id","event_name")
);
--> statement-breakpoint
CREATE TABLE "suppression_state" (
	"user_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"last_shown_at" timestamp with time zone NOT NULL,
	"last_action" "last_action",
	"next_eligible_at" timestamp with time zone,
	CONSTRAINT "suppression_state_user_id_workflow_id_pk" PRIMARY KEY("user_id","workflow_id")
);
--> statement-breakpoint
CREATE TABLE "trigger_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"event_name" text NOT NULL,
	"context" text,
	"shown_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"event_name" text,
	"sampling_rate" numeric(4, 3) DEFAULT '1.000' NOT NULL,
	"metric_type" "metric_type",
	"rating_type" "rating_type",
	"rating_scale_max" integer,
	"header_text" text,
	"positive_threshold" integer,
	"chips_on_negative" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"other_requires_text" boolean DEFAULT true NOT NULL,
	"other_allows_image" boolean DEFAULT false NOT NULL,
	"on_positive_action" "on_positive_action" DEFAULT 'none' NOT NULL,
	"ask_frequency" "ask_frequency" DEFAULT 'after_7_days' NOT NULL,
	"min_session_age_days" integer,
	"status" "workflow_status" DEFAULT 'draft' NOT NULL,
	"key" text,
	"managed_by" "workflow_managed_by" DEFAULT 'console' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_active_complete" CHECK (
        "workflows"."status" <> 'active' OR (
          "workflows"."event_name" IS NOT NULL AND "workflows"."metric_type" IS NOT NULL AND "workflows"."rating_type" IS NOT NULL
          AND "workflows"."rating_scale_max" IS NOT NULL AND "workflows"."header_text" IS NOT NULL
          AND "workflows"."positive_threshold" IS NOT NULL
        )
      )
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_tokens" ADD CONSTRAINT "cli_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_users" ADD CONSTRAINT "console_users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_trigger_id_trigger_log_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."trigger_log"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seen_events" ADD CONSTRAINT "seen_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_state" ADD CONSTRAINT "suppression_state_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_log" ADD CONSTRAINT "trigger_log_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_log" ADD CONSTRAINT "trigger_log_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_unique" ON "api_keys" USING btree ("key");--> statement-breakpoint
CREATE INDEX "api_keys_account_idx" ON "api_keys" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_tokens_token_hash_unique" ON "cli_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "cli_tokens_account_idx" ON "cli_tokens" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_authorizations_device_code_hash_unique" ON "device_authorizations" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "device_authorizations_user_code_unique" ON "device_authorizations" USING btree ("user_code");--> statement-breakpoint
CREATE UNIQUE INDEX "responses_trigger_id_unique" ON "responses" USING btree ("trigger_id");--> statement-breakpoint
CREATE INDEX "responses_reporting_idx" ON "responses" USING btree ("workflow_id","responded_at");--> statement-breakpoint
CREATE INDEX "trigger_log_cap_idx" ON "trigger_log" USING btree ("workflow_id","user_id","shown_at");--> statement-breakpoint
CREATE INDEX "workflows_account_idx" ON "workflows" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_active_event_unique" ON "workflows" USING btree ("account_id","event_name") WHERE "workflows"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_account_key_unique" ON "workflows" USING btree ("account_id","key") WHERE "workflows"."key" IS NOT NULL;