import {
  boolean,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employees } from './employees.schema.ts';
import { trainingChapters } from './training-chapters.schema.ts';
import { trainingCourses } from './training-courses.schema.ts';

/** Per-employee assignment and current course position. */
export const trainingCourseAssignments = pgTable(
  'training_course_assignments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => trainingCourses.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    isRequired: boolean('is_required').notNull().default(false),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    currentChapterId: uuid('current_chapter_id').references(
      () => trainingChapters.id,
      { onDelete: 'set null' },
    ),
    courseCompletedAt: timestamp('course_completed_at', {
      withTimezone: true,
    }),
    assignedAt: timestamp('assigned_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    overrideUntil: timestamp('override_until', { withTimezone: true }),
    overriddenBy: uuid('overridden_by').references(() => employees.id, {
      onDelete: 'set null',
    }),
    overriddenAt: timestamp('overridden_at', { withTimezone: true }),
    overrideReason: text('override_reason'),
  },
  (t) => ({
    courseEmployeeUnique: uniqueIndex(
      'training_course_assignments_course_employee_uniq',
    ).on(t.courseId, t.employeeId),
    byEmployee: index('training_course_assignments_employee_idx').on(
      t.employeeId,
    ),
    byCourse: index('training_course_assignments_course_idx').on(t.courseId),
  }),
);

export type TrainingCourseAssignment =
  typeof trainingCourseAssignments.$inferSelect;
