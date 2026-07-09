CREATE TYPE "public"."console_user_role" AS ENUM('admin', 'editor');--> statement-breakpoint
CREATE TABLE "console_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" "console_user_role" DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "console_users_email_unique" UNIQUE("email")
);
