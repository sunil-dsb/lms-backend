ALTER TABLE "training_course_assignments" ALTER COLUMN "is_required" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "procedures" ADD COLUMN IF NOT EXISTS "promo_starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_courses" ADD COLUMN IF NOT EXISTS "station_ids" uuid[];