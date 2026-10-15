ALTER TABLE "procedures" DROP CONSTRAINT IF EXISTS "procedures_station_id_stations_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "procedures_station_idx";--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "station_ids" uuid[];--> statement-breakpoint
ALTER TABLE "subcategories" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "subcategories" ADD COLUMN IF NOT EXISTS "subcategory_icon" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employees_email_uniq" ON "employees" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employees_location_idx" ON "employees" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "categories_status_idx" ON "categories" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedures_updated_at_idx" ON "procedures" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcategories_status_idx" ON "subcategories" USING btree ("status");--> statement-breakpoint
ALTER TABLE "procedures" DROP COLUMN IF EXISTS "station_id";--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "assign_users" uuid[];--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "previous_status" text;--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "procedure_image" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'employee' NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "require_password_change" boolean DEFAULT true NOT NULL;