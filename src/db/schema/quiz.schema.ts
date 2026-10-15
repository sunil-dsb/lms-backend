import { pgTable, text, timestamp, uuid, jsonb } from 'drizzle-orm/pg-core';
import crypto from 'node:crypto';
import { user } from './auth.schema.ts';
import { z } from 'zod';
export const quizTypes = ['procedure', 'course'] as const;
export type QuizType = (typeof quizTypes)[number];

export const quiz = pgTable('quiz', {
  id: uuid('id').primaryKey().defaultRandom(),
  nameEn: text('name_en').notNull(),
  nameEs: text('name_es').notNull(),
  quizType: text('quiz_type').$type<QuizType>().notNull().default('procedure'),
  questions: jsonb('questions').$type<unknown>().notNull().default([]),
  createdBy: text('created_by').references(() => user.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type Quiz = typeof quiz.$inferSelect;
export type NewQuiz = typeof quiz.$inferInsert;

const localisedString = z.object({
  en: z.string().trim().min(1, 'English text cannot be empty'),
  es: z.string().trim().optional(),
});

export const quizChoiceSchema = z.object({
  id: z.string().trim().min(1, 'Choice ID is required'),
  label: localisedString,
});

export const quizQuestionSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1, 'Question ID cannot be empty')
      .optional()
      .default(() => crypto.randomUUID()),
    question: localisedString,
    choices: z
      .array(quizChoiceSchema)
      .min(2, 'Each question must have at least 2 choices/options'),
    correctChoiceId: z
      .string()
      .trim()
      .min(
        1,
        'A correct answer (correctChoiceId) is required for every question',
      ),
  })
  .refine((q) => q.choices.some((c) => c.id === q.correctChoiceId), {
    message: 'correctChoiceId must match one of the choices',
    path: ['correctChoiceId'],
  });

export const createQuizInputSchema = z.object({
  nameEn: z.string().trim().min(1, 'English name is required'),
  nameEs: z.string().trim().min(1, 'Spanish name is required'),
  quizType: z.enum(['procedure', 'course']).optional(),
  procedureId: z.string().uuid().nullable().optional(),
  questions: z.array(quizQuestionSchema).default([]),
});
export type CreateQuizInput = z.infer<typeof createQuizInputSchema>;

export const updateQuizInputSchema = z.object({
  nameEn: z.string().trim().min(1, 'English name cannot be empty').optional(),
  nameEs: z.string().trim().min(1, 'Spanish name cannot be empty').optional(),
  quizType: z.enum(['procedure', 'course']).optional(),
  procedureId: z.string().uuid().nullable().optional(),
  questions: z.array(quizQuestionSchema).optional(),
});
export type UpdateQuizInput = z.infer<typeof updateQuizInputSchema>;

export type QuizQuestion = z.infer<typeof quizQuestionSchema>;
export type QuizChoice = z.infer<typeof quizChoiceSchema>;

export type QuizProcedureSummary = {
  id: string;
  slug: string;
  titleEn: string;
  titleEs: string;
  status: string;
};

export type QuizWithProcedure = Quiz & {
  procedureId: string | null;
  procedure: QuizProcedureSummary | null;
};
