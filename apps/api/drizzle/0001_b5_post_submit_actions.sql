-- B5 (B5-D1, B5-D5): replace the `on_positive_action` enum with two branchable
-- jsonb action configs (`positive_action` / `negative_action`), each
-- `{ type: 'none'|'thanks'|'redirect'|'store_review', message?, url? }`.
-- First INCREMENTAL migration after the B4 freeze — 0000 is NOT rewritten.
ALTER TABLE "workflows" ADD COLUMN "positive_action" jsonb DEFAULT '{"type":"none"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "negative_action" jsonb DEFAULT '{"type":"none"}'::jsonb NOT NULL;--> statement-breakpoint
-- B5-D5 backfill: carry the old enum onto the new positive action BEFORE dropping it.
-- `play_store_review` -> positive `store_review`; `none` -> positive `none` (the column
-- default already applied). Negative action defaults to `none` for every existing row.
UPDATE "workflows" SET "positive_action" = '{"type":"store_review"}'::jsonb WHERE "on_positive_action" = 'play_store_review';--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN "on_positive_action";--> statement-breakpoint
DROP TYPE "public"."on_positive_action";

-- Rollback (dev only; drizzle-kit migrations are forward-only, kept here for safety):
--   CREATE TYPE "public"."on_positive_action" AS ENUM('none', 'play_store_review');
--   ALTER TABLE "workflows" ADD COLUMN "on_positive_action" "on_positive_action" DEFAULT 'none' NOT NULL;
--   UPDATE "workflows" SET "on_positive_action" = 'play_store_review' WHERE "positive_action"->>'type' = 'store_review';
--   ALTER TABLE "workflows" DROP COLUMN "positive_action";
--   ALTER TABLE "workflows" DROP COLUMN "negative_action";
