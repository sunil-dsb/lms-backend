import { z } from 'zod';
import type { QuizQuestion } from '../../db/schema/quiz.schema.ts';

export interface ProcedureContextInput {
  titleEn?: string | undefined;
  titleEs?: string | undefined;
  purposeEn?: string | undefined;
  purposeEs?: string | undefined;
  blocks?: Array<Record<string, unknown>> | undefined;
  ingredients?: Array<Record<string, unknown>> | undefined;
}

export interface ChapterContextInput {
  courseId?: string | undefined;
  courseName?: string | undefined;
  chapterId?: string | undefined;
  chapterNumber?: number | undefined;
  titleEn?: string | undefined;
  titleEs?: string | undefined;
  purposeEn?: string | undefined;
  purposeEs?: string | undefined;
  procedureId?: string | null | undefined;
  procedureIds?: string[] | undefined;
  blocks?: Array<Record<string, unknown>> | undefined;
}

export interface QuizGenerationConfig {
  totalQuestions?: number | undefined;
  mcqCount?: number | undefined;
  sequenceCount?: number | undefined;
}

export interface GeneratedQuizResult {
  nameEn: string;
  nameEs: string;
  questions: QuizQuestion[];
  advisory?: string | null | undefined;
}

export const generateChapterQuizInputSchema = z
  .object({
    chapterId: z.string().uuid().optional(),
    chapter: z
      .object({
        courseId: z.string().uuid().optional(),
        courseName: z.string().trim().optional(),
        chapterNumber: z.number().int().optional(),
        titleEn: z.string().trim().optional(),
        titleEs: z.string().trim().optional(),
        purposeEn: z.string().trim().optional(),
        purposeEs: z.string().trim().optional(),
        procedureId: z.string().uuid().nullable().optional(),
        procedureIds: z.array(z.string().uuid()).optional(),
        blocks: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .default([]),
      })
      .optional(),
    config: z
      .object({
        totalQuestions: z.number().int().min(2).max(10).optional(),
        mcqCount: z.number().int().min(0).max(10).optional(),
        sequenceCount: z.number().int().min(0).max(10).optional(),
      })
      .optional()
      .refine(
        (cfg) => {
          if (!cfg) return true;
          if (cfg.mcqCount !== undefined && cfg.sequenceCount !== undefined) {
            const sum = cfg.mcqCount + cfg.sequenceCount;
            return sum >= 2 && sum <= 10;
          }
          return true;
        },
        {
          message:
            'The sum of mcqCount and sequenceCount must be between 2 and 10.',
        },
      ),
  })
  .refine((data) => Boolean(data.chapter || data.chapterId), {
    message:
      'Either in-memory "chapter" content or a "chapterId" must be provided.',
  });

export const generateQuizInputSchema = z
  .object({
    procedureId: z.string().uuid().optional(),
    procedure: z
      .object({
        titleEn: z.string().trim().optional(),
        titleEs: z.string().trim().optional(),
        purposeEn: z.string().trim().optional(),
        purposeEs: z.string().trim().optional(),
        procedureId: z.string().uuid().nullable().optional(),
        procedureIds: z.array(z.string().uuid()).optional(),
        blocks: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .default([]),
        ingredients: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .default([]),
      })
      .optional(),
    config: z
      .object({
        totalQuestions: z.number().int().min(2).max(10).optional(),
        mcqCount: z.number().int().min(0).max(10).optional(),
        sequenceCount: z.number().int().min(0).max(10).optional(),
      })
      .optional()
      .refine(
        (cfg) => {
          if (!cfg) return true;
          if (cfg.mcqCount !== undefined && cfg.sequenceCount !== undefined) {
            const sum = cfg.mcqCount + cfg.sequenceCount;
            return sum >= 2 && sum <= 10;
          }
          return true;
        },
        {
          message:
            'The sum of mcqCount and sequenceCount must be between 2 and 10.',
        },
      ),
  })
  .refine((data) => Boolean(data.procedure || data.procedureId), {
    message:
      'Either in-memory "procedure" content or a "procedureId" must be provided.',
  });

export interface RawAiChoice {
  id?: string;
  label?: { en?: string; es?: string };
}

export interface RawAiSequenceItem {
  id?: string;
  label?: { en?: string; es?: string };
}

export interface RawAiQuestion {
  id?: string;
  type?: 'multiple_choice' | 'sequence';
  prompt?: { en?: string; es?: string };
  question?: { en?: string; es?: string };
  choices?: RawAiChoice[];
  correctChoiceId?: string;
  sequenceItems?: RawAiSequenceItem[];
}

export interface RawAiQuizResponse {
  nameEn?: string;
  nameEs?: string;
  questions?: RawAiQuestion[];
}

export interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}
