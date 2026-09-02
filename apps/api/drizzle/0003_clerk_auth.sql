-- F3 Clerk dashboard login: console users may authenticate via Clerk. Add
-- `clerk_user_id` (unique) and widen the has-credential CHECK to accept it, so a
-- Clerk-only user (no password, no google_sub) is valid.
ALTER TABLE "console_users" ADD COLUMN "clerk_user_id" text;
--> statement-breakpoint
ALTER TABLE "console_users" ADD CONSTRAINT "console_users_clerk_user_id_unique" UNIQUE("clerk_user_id");
--> statement-breakpoint
ALTER TABLE "console_users" DROP CONSTRAINT "console_users_has_credential";
--> statement-breakpoint
ALTER TABLE "console_users" ADD CONSTRAINT "console_users_has_credential"
  CHECK ("password_hash" IS NOT NULL OR "google_sub" IS NOT NULL OR "clerk_user_id" IS NOT NULL);
