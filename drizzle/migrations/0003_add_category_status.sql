ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "categories_status_idx" ON "categories" ("status");