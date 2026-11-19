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

const localisedString = z
  .object({
    en: z.string().trim().optional(),
    es: z.string().trim().optional(),
  })
  .refine((v) => Boolean(v.en?.trim() || v.es?.trim()), {
    message: 'Text cannot be empty',
  })
  .transform((v) => ({
    en: v.en?.trim() || v.es?.trim() || '',
    es: v.es?.trim() || v.en?.trim() || '',
  }));

const localisedOptionalString = z
  .object({
    en: z.string().trim().optional(),
    es: z.string().trim().optional(),
  })
  .optional()
  .transform((v) => {
    if (!v) return undefined;
    const en = v.en?.trim() || '';
    const es = v.es?.trim() || '';
    if (!en && !es) return undefined;
    return {
      en: en || es,
      es: es || en,
    };
  });

export const quizChoiceSchema = z.object({
  id: z.string().trim().min(1, 'Choice ID is required'),
  label: localisedString,
});

export const quizSequenceItemSchema = z.object({
  id: z.string().trim().min(1, 'Item ID is required'),
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
    type: z
      .enum(['multiple_choice', 'sequence'])
      .optional()
      .default('multiple_choice'),
    question: localisedOptionalString,
    prompt: localisedOptionalString,
    choices: z.array(quizChoiceSchema).optional(),
    correctChoiceId: z.string().trim().optional(),
    sequenceItems: z.array(quizSequenceItemSchema).optional(),
  })
  .superRefine((q, ctx) => {
    const hasQuestion = Boolean(
      q.question?.en?.trim() || q.question?.es?.trim(),
    );
    const hasPrompt = Boolean(q.prompt?.en?.trim() || q.prompt?.es?.trim());
    if (!hasQuestion && !hasPrompt && q.type !== 'sequence') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Question prompt cannot be empty',
        path: ['question'],
      });
    }

    if (q.type === 'sequence') {
      if (!Array.isArray(q.sequenceItems) || q.sequenceItems.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Sequence questions must have at least 2 steps in order',
          path: ['sequenceItems'],
        });
      } else if (q.sequenceItems.length > 25) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Sequence questions cannot have more than 25 steps',
          path: ['sequenceItems'],
        });
      } else {
        const seenIds = new Set<string>();
        const seenLabels = new Set<string>();
        q.sequenceItems.forEach((item, idx) => {
          if (item.id) {
            if (seenIds.has(item.id)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Duplicate step ID: ${item.id}`,
                path: ['sequenceItems', idx, 'id'],
              });
            }
            seenIds.add(item.id);
          }
          const en = (item.label?.en || '').trim().toLowerCase();
          const es = (item.label?.es || '').trim().toLowerCase();
          const key = `${en}|||${es}`;
          if (key !== '|||') {
            if (seenLabels.has(key)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Step ${idx + 1} has duplicate text. Each step must have distinct instructions.`,
                path: ['sequenceItems', idx, 'label'],
              });
            }
            seenLabels.add(key);
          }
        });
      }
    } else {
      if (!Array.isArray(q.choices) || q.choices.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Each question must have at least 2 choices/options',
          path: ['choices'],
        });
      } else if (!q.correctChoiceId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'A correct answer (correctChoiceId) is required for every question',
          path: ['correctChoiceId'],
        });
      } else if (!q.choices.some((c) => c.id === q.correctChoiceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'correctChoiceId must match one of the choices',
          path: ['correctChoiceId'],
        });
      }
    }
  })
  .transform((q) => {
    const defaultSeqPrompt = {
      en: 'Arrange the following steps in the correct order:',
      es: 'Organiza los siguientes pasos en el orden correcto:',
    };
    const prompt =
      q.prompt ||
      q.question ||
      (q.type === 'sequence' ? defaultSeqPrompt : { en: '', es: '' });
    return {
      ...q,
      prompt,
      question: q.question || prompt,
    };
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

export const checkAnswerInputSchema = z.object({
  questionId: z.string().trim().min(1, 'Question ID is required'),
  sequenceOrder: z.array(z.string().trim()).optional(),
  choiceId: z.string().trim().optional(),
});
export type CheckAnswerInput = z.infer<typeof checkAnswerInputSchema>;

export const checkBatchAnswersInputSchema = z.object({
  answers: z.array(checkAnswerInputSchema),
});
export type CheckBatchAnswersInput = z.infer<
  typeof checkBatchAnswersInputSchema
>;
