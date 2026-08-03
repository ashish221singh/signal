CREATE TYPE "public"."api_key_environment" AS ENUM('live', 'test');--> statement-breakpoint
CREATE TYPE "public"."ask_frequency" AS ENUM('after_7_days', 'after_30_days', 'after_60_days');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."console_user_role" AS ENUM('admin', 'editor');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('not_sent', 'sent_to_engineering', 'confirmed_live');--> statement-breakpoint
CREATE TYPE "public"."last_action" AS ENUM('dismissed', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."metric_type" AS ENUM('CSAT', 'CES');--> statement-breakpoint
CREATE TYPE "public"."on_positive_action" AS ENUM('none', 'play_store_review');--> statement-breakpoint
CREATE TYPE "public"."rating_type" AS ENUM('star', 'emoji', 'effort_scale');--> statement-breakpoint
CREATE TYPE "public"."trigger_mechanism" AS ENUM('action', 'dwell');--> statement-breakpoint
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"target_id" uuid,
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
	"min_tenure_days" integer,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_active_complete" CHECK (
        "campaigns"."status" <> 'active' OR (
          "campaigns"."target_id" IS NOT NULL AND "campaigns"."metric_type" IS NOT NULL AND "campaigns"."rating_type" IS NOT NULL
          AND "campaigns"."rating_scale_max" IS NOT NULL AND "campaigns"."header_text" IS NOT NULL
          AND "campaigns"."positive_threshold" IS NOT NULL
        )
      )
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
CREATE TABLE "responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"trigger_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"screen_id" text NOT NULL,
	"rating_value" integer NOT NULL,
	"chip_selected" text,
	"other_text" text,
	"other_image_url" text,
	"location" jsonb,
	"device_os" text NOT NULL,
	"app_version" text NOT NULL,
	"rep_tenure_days" integer,
	"shown_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppression_state" (
	"user_id" text NOT NULL,
	"campaign_id" uuid NOT NULL,
	"last_shown_at" timestamp with time zone NOT NULL,
	"last_action" "last_action",
	"next_eligible_at" timestamp with time zone,
	CONSTRAINT "suppression_state_user_id_campaign_id_pk" PRIMARY KEY("user_id","campaign_id")
);
--> statement-breakpoint
CREATE TABLE "target_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"screen_id" text NOT NULL,
	"trigger_mechanism" "trigger_mechanism" NOT NULL,
	"integration_status" "integration_status" DEFAULT 'not_sent' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"screen_id" text NOT NULL,
	"shown_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_target_id_target_registry_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."target_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_users" ADD CONSTRAINT "console_users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_trigger_id_trigger_log_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."trigger_log"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_state" ADD CONSTRAINT "suppression_state_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_registry" ADD CONSTRAINT "target_registry_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_log" ADD CONSTRAINT "trigger_log_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_log" ADD CONSTRAINT "trigger_log_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_unique" ON "api_keys" USING btree ("key");--> statement-breakpoint
CREATE INDEX "api_keys_account_idx" ON "api_keys" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "campaigns_status_target_idx" ON "campaigns" USING btree ("status","target_id");--> statement-breakpoint
CREATE INDEX "campaigns_account_idx" ON "campaigns" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "responses_trigger_id_unique" ON "responses" USING btree ("trigger_id");--> statement-breakpoint
CREATE INDEX "responses_reporting_idx" ON "responses" USING btree ("campaign_id","responded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "target_registry_account_screen_unique" ON "target_registry" USING btree ("account_id","screen_id");--> statement-breakpoint
CREATE INDEX "trigger_log_cap_idx" ON "trigger_log" USING btree ("campaign_id","user_id","shown_at");