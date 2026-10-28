import { pgTable, text, timestamp, index, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.schema.ts';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Status — courses are always created as 'published'.
// No draft state exists in the UI; 'archived' is the only other status.
// ---------------------------------------------------------------------------
export const trainingCourseStatuses = ['published', 'archived'] as const;
export type TrainingCourseStatus = (typeof trainingCourseStatuses)[number];

export const trainingCourses = pgTable(
  'training_courses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    titleEn: text('title_en').notNull(),
    titleEs: text('title_es').notNull(),
    purposeEn: text('purpose_en').notNull(),
    purposeEs: text('purpose_es').notNull(),
    status: text('status')
      .$type<TrainingCourseStatus>()
      .notNull()
      .default('published'),
    assignUsers: uuid('assign_users').array(),
    createdBy: text('created_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    byStatus: index('training_courses_status_idx').on(t.status),
    // Admin lists are ordered newest-updated first.
    byUpdatedAt: index('training_courses_updated_at_idx').on(t.updatedAt),
  }),
);

export type TrainingCourse = typeof trainingCourses.$inferSelect;
export type NewTrainingCourse = typeof trainingCourses.$inferInsert;

// ===========================================================================
// Zod validation schemas
// ===========================================================================

/** Used when saving a chapter inline during course create / update. */
export const chapterInputSchema = z.object({
  /** Client-generated id; if absent the server issues a new uuid. */
  id: z.string().uuid().optional(),
  number: z.number().int().min(1),
  titleEn: z.string().trim().min(1, 'English chapter title is required'),
  titleEs: z.string().trim().min(1, 'Spanish chapter title is required'),
  subtitleEn: z.string().trim().default(''),
  subtitleEs: z.string().trim().default(''),
  blocks: z.array(z.unknown()).default([]),
  procedureId: z.string().uuid().nullable().optional(),
  quizId: z.string().uuid().nullable().optional(),
  minCorrectAnswers: z.number().int().min(0).nullable().optional(),
});
export type ChapterInput = z.infer<typeof chapterInputSchema>;

export const createCourseInputSchema = z.object({
  titleEn: z.string().trim().min(1, 'English title is required'),
  titleEs: z.string().trim().min(1, 'Spanish title is required'),
  purposeEn: z.string().trim().min(1, 'English purpose is required'),
  purposeEs: z.string().trim().min(1, 'Spanish purpose is required'),
  assignUsers: z.array(z.string().uuid()).optional(),
  /** Chapters can be supplied immediately on creation. */
  chapters: z.array(chapterInputSchema).default([]),
});
export type CreateCourseInput = z.infer<typeof createCourseInputSchema>;

export const updateCourseInputSchema = z.object({
  titleEn: z.string().trim().min(1).optional(),
  titleEs: z.string().trim().min(1).optional(),
  purposeEn: z.string().trim().min(1).optional(),
  purposeEs: z.string().trim().min(1).optional(),
  assignUsers: z.array(z.string().uuid()).optional(),
  /**
   * Full chapter array. When provided the service replaces the entire chapter
   * set (delete omitted chapters, upsert provided ones) inside a transaction.
   */
  chapters: z.array(chapterInputSchema).optional(),
});
export type UpdateCourseInput = z.infer<typeof updateCourseInputSchema>;

export const assignCourseInputSchema = z.object({
  employeeIds: z.array(z.string().uuid()).default([]),
  mode: z.enum(['add', 'replace']).default('add'),
});
export type AssignCourseInput = z.infer<typeof assignCourseInputSchema>;
