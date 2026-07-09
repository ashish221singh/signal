ALTER TYPE "public"."campaign_status" ADD VALUE 'archived';--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "target_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "client_ids" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "metric_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "rating_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "rating_scale_max" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "header_text" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "positive_threshold" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "chips_on_negative" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "ask_frequency" SET DEFAULT 'after_7_days';--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_active_complete" CHECK (
        "campaigns"."status" <> 'active' OR (
          "campaigns"."target_id" IS NOT NULL AND "campaigns"."metric_type" IS NOT NULL AND "campaigns"."rating_type" IS NOT NULL
          AND "campaigns"."rating_scale_max" IS NOT NULL AND "campaigns"."header_text" IS NOT NULL
          AND "campaigns"."positive_threshold" IS NOT NULL AND jsonb_array_length("campaigns"."client_ids") >= 1
        )
      );