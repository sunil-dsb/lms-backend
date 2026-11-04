ALTER TABLE "training_course_assignments"
  ADD COLUMN "is_required" boolean NOT NULL DEFAULT false;

UPDATE "training_course_assignments" AS assignment
SET "is_required" = true
FROM "training_courses" AS course
WHERE assignment."course_id" = course."id"
  AND course."is_required_orientation" = true;

ALTER TABLE "training_courses"
  DROP COLUMN "is_required_orientation";
