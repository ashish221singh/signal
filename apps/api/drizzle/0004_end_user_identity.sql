-- F5 end-user identity: the client's own user name/email captured at response time.
-- The stable client user id already lives on responses.user_id; these add the
-- human-readable traits. Both nullable (anonymous / logged-out responses carry none).
ALTER TABLE "responses" ADD COLUMN IF NOT EXISTS "user_name" text;
ALTER TABLE "responses" ADD COLUMN IF NOT EXISTS "user_email" text;
