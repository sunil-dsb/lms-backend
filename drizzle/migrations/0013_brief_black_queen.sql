CREATE TABLE "employee_supervisors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"supervisor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supervisor_managers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supervisor_id" uuid NOT NULL,
	"manager_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "date_of_birth" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "fathers_name" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "gender" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "phone_number" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "emergency_contact_name" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "emergency_contact_relation" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "emergency_contact_phone" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "start_date" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "sin_number" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "hourly_rate" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "employee_supervisors" ADD CONSTRAINT "employee_supervisors_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_supervisors" ADD CONSTRAINT "employee_supervisors_supervisor_id_employees_id_fk" FOREIGN KEY ("supervisor_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervisor_managers" ADD CONSTRAINT "supervisor_managers_supervisor_id_employees_id_fk" FOREIGN KEY ("supervisor_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervisor_managers" ADD CONSTRAINT "supervisor_managers_manager_id_employees_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "emp_sup_pair_uniq" ON "employee_supervisors" USING btree ("employee_id","supervisor_id");--> statement-breakpoint
CREATE INDEX "emp_sup_employee_idx" ON "employee_supervisors" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "emp_sup_supervisor_idx" ON "employee_supervisors" USING btree ("supervisor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sup_mgr_pair_uniq" ON "supervisor_managers" USING btree ("supervisor_id","manager_id");--> statement-breakpoint
CREATE INDEX "sup_mgr_supervisor_idx" ON "supervisor_managers" USING btree ("supervisor_id");--> statement-breakpoint
CREATE INDEX "sup_mgr_manager_idx" ON "supervisor_managers" USING btree ("manager_id");--> statement-breakpoint
CREATE INDEX "employees_role_idx" ON "employees" USING btree ("role");