ALTER TABLE "procedures" DROP CONSTRAINT "procedures_station_id_stations_id_fk";
--> statement-breakpoint
DROP INDEX "procedures_station_idx";--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN "station_ids" uuid[];--> statement-breakpoint
ALTER TABLE "subcategories" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_email_uniq" ON "employees" USING btree ("email");--> statement-breakpoint
CREATE INDEX "employees_location_idx" ON "employees" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "categories_status_idx" ON "categories" USING btree ("status");--> statement-breakpoint
CREATE INDEX "procedures_updated_at_idx" ON "procedures" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "subcategories_status_idx" ON "subcategories" USING btree ("status");--> statement-breakpoint
ALTER TABLE "procedures" DROP COLUMN "station_id";