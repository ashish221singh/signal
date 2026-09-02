-- F3 Google OAuth: console users may now authenticate with Google instead of a
-- password. `password_hash` becomes nullable; `google_sub` (Google's stable subject
-- id) is added, unique when present. A CHECK enforces every user has at least one
-- credential (a password hash OR a Google identity).
ALTER TABLE "console_users" ALTER COLUMN "password_hash" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "console_users" ADD COLUMN "google_sub" text;
--> statement-breakpoint
ALTER TABLE "console_users" ADD CONSTRAINT "console_users_google_sub_unique" UNIQUE("google_sub");
--> statement-breakpoint
ALTER TABLE "console_users" ADD CONSTRAINT "console_users_has_credential"
  CHECK ("password_hash" IS NOT NULL OR "google_sub" IS NOT NULL);
