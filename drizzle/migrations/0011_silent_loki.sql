CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"user_name" text NOT NULL,
	"item_type" text NOT NULL,
	"item_id" text NOT NULL,
	"item_name" text,
	"action" text NOT NULL,
	"changes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "training_course_assignments" ADD COLUMN "override_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_course_assignments" ADD COLUMN "overridden_by" uuid;--> statement-breakpoint
ALTER TABLE "training_course_assignments" ADD COLUMN "overridden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_course_assignments" ADD COLUMN "override_reason" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_item_idx" ON "audit_logs" USING btree ("item_type","item_id");--> statement-breakpoint
CREATE INDEX "audit_logs_user_idx" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_date_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "training_course_assignments" ADD CONSTRAINT "training_course_assignments_overridden_by_employees_id_fk" FOREIGN KEY ("overridden_by") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;