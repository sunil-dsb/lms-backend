CREATE TABLE IF NOT EXISTS "training_course_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"due_date" date NOT NULL,
	"current_chapter_id" uuid,
	"course_completed_at" timestamp with time zone,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "training_courses" ADD COLUMN IF NOT EXISTS "assign_users" uuid[];
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "training_course_assignments" ADD CONSTRAINT "training_course_assignments_course_id_training_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."training_courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "training_course_assignments" ADD CONSTRAINT "training_course_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "training_course_assignments" ADD CONSTRAINT "training_course_assignments_current_chapter_id_training_chapters_id_fk" FOREIGN KEY ("current_chapter_id") REFERENCES "public"."training_chapters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "training_course_assignments_course_employee_uniq" ON "training_course_assignments" USING btree ("course_id","employee_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_course_assignments_employee_idx" ON "training_course_assignments" USING btree ("employee_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_course_assignments_course_idx" ON "training_course_assignments" USING btree ("course_id");