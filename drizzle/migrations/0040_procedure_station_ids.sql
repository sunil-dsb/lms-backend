ALTER TABLE "procedures" ADD COLUMN "station_ids" uuid[];
--> statement-breakpoint
UPDATE "procedures" SET "station_ids" = ARRAY["station_id"] WHERE "station_id" IS NOT NULL;
