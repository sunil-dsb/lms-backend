import {
  pgTable,
  text,
  jsonb,
  timestamp,
  integer,
  uniqueIndex,
  index,
  uuid,
} from 'drizzle-orm/pg-core';
import { trainingCourses } from './training-courses.schema.ts';
import { procedures } from './procedures.schema.ts';
import { quiz } from './quiz.schema.ts';

export const trainingChapters = pgTable(
  'training_chapters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // CASCADE — when the course is deleted all its chapters go with it.
    courseId: uuid('course_id')
      .notNull()
      .references(() => trainingCourses.id, { onDelete: 'cascade' }),
    // 1-based display order ("Chapter 1", "Chapter 2", …).
    number: integer('number').notNull(),
    titleEn: text('title_en').notNull(),
    titleEs: text('title_es').notNull(),
    subtitleEn: text('subtitle_en').notNull().default(''),
    subtitleEs: text('subtitle_es').notNull().default(''),
    // Rich content blocks — same shape as procedures.blocks_en / blocks_es.
    blocks: jsonb('blocks').$type<unknown[]>().notNull().default([]),
    // Optional attached procedure (SET NULL if procedure is deleted).
    procedureId: uuid('procedure_id').references(() => procedures.id, {
      onDelete: 'set null',
    }),
    // Optional quiz attached to this chapter (SET NULL if quiz is deleted).
    quizId: uuid('quiz_id').references(() => quiz.id, {
      onDelete: 'set null',
    }),
    // Minimum correct answers required to pass this chapter's quiz.
    minCorrectAnswers: integer('min_correct_answers'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // Prevents two chapters from sharing the same number within a course.
    courseNumberUniq: uniqueIndex('training_chapters_course_number_uniq').on(
      t.courseId,
      t.number,
    ),
    // Fast retrieval of all chapters for a given course.
    byCourse: index('training_chapters_course_idx').on(t.courseId),
    // Lets us look up which chapters reference a specific procedure.
    byProcedure: index('training_chapters_procedure_idx').on(t.procedureId),
    // Lets us look up which chapters reference a specific quiz.
    byQuiz: index('training_chapters_quiz_idx').on(t.quizId),
  }),
);

export type TrainingChapter = typeof trainingChapters.$inferSelect;
export type NewTrainingChapter = typeof trainingChapters.$inferInsert;
