ALTER TABLE "training_courses" ADD COLUMN IF NOT EXISTS "location_ids" uuid[];--> statement-breakpoint
ALTER TABLE "training_courses" ADD COLUMN IF NOT EXISTS "job_ids" uuid[];