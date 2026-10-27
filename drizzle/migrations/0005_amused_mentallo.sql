CREATE TABLE IF NOT EXISTS "training_courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_en" text NOT NULL,
	"title_es" text NOT NULL,
	"purpose_en" text NOT NULL,
	"purpose_es" text NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "training_chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title_en" text NOT NULL,
	"title_es" text NOT NULL,
	"subtitle_en" text DEFAULT '' NOT NULL,
	"subtitle_es" text DEFAULT '' NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"procedure_id" uuid,
	"quiz_id" uuid,
	"min_correct_answers" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "training_courses" ADD CONSTRAINT "training_courses_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "training_chapters" ADD CONSTRAINT "training_chapters_course_id_training_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."training_courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "training_chapters" ADD CONSTRAINT "training_chapters_procedure_id_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedures"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "training_chapters" ADD CONSTRAINT "training_chapters_quiz_id_quiz_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quiz"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_courses_status_idx" ON "training_courses" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_courses_updated_at_idx" ON "training_courses" USING btree ("updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "training_chapters_course_number_uniq" ON "training_chapters" USING btree ("course_id","number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_chapters_course_idx" ON "training_chapters" USING btree ("course_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_chapters_procedure_idx" ON "training_chapters" USING btree ("procedure_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "training_chapters_quiz_idx" ON "training_chapters" USING btree ("quiz_id");
