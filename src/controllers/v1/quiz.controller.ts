import type { Request, Response } from 'express';
import catchAsync from '../../shared/utils/catchAsync.ts';
import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import {
  createQuizInputSchema,
  updateQuizInputSchema,
  checkAnswerInputSchema,
  checkBatchAnswersInputSchema,
} from '../../db/quiz.schema.ts';
import * as quizzesService from '../../services/quiz/quiz.service.ts';
import * as quizAiService from '../../services/quiz/quiz-ai.service.ts';
import {
  generateQuizInputSchema,
  generateChapterQuizInputSchema,
} from '../../services/quiz/quiz-ai.service.ts';
import { getPaginationParams } from '../../shared/utils/pagination.ts';
import { db } from '../../db/client.ts';
import { procedures } from '../../db/procedure.schema.ts';
import { trainingChapters } from '../../db/schema/training-chapters.schema.ts';
import { trainingCourses } from '../../db/schema/training-courses.schema.ts';
import { eq } from 'drizzle-orm';
import { parseStoredBody } from '../../services/procedures/procedures.service.ts';

// POST /api/admin/library/quizzes
export const createQuiz = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const parsed = createQuizInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }

    const quiz = await quizzesService.createQuiz(parsed.data, {
      userId: req.userId,
      name: req.user?.name,
    });

    res
      .status(201)
      .json(ApiResponse.success('Quiz created successfully', { quiz }));
  },
);

// GET /api/v1/quizzes/:id
export const getQuiz = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const quizId = Array.isArray(id) ? id[0] : id;
    if (!quizId) {
      throw new ApiError('Quiz ID is required', 400);
    }

    const quiz = await quizzesService.getQuiz(quizId);

    res.status(200).json(ApiResponse.success('Quiz fetched', { quiz }));
  },
);

// GET /api/v1/quizzes
export const listQuizzes = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { page, limit, search } = getPaginationParams(req.query);
    const quizzes = await quizzesService.listQuizzes(page, limit, search);

    res.status(200).json(
      ApiResponse.success('Quizzes fetched successfully', {
        quizzes: quizzes.items,
        meta: quizzes.meta,
      }),
    );
  },
);

// PATCH /api/v1/quizzes/:id  (super_admin only)
export const updateQuiz = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const { id } = req.params;
    const quizId = Array.isArray(id) ? id[0] : id;
    if (!quizId) {
      throw new ApiError('Quiz ID is required', 400);
    }

    const parsed = updateQuizInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }

    const quiz = await quizzesService.updateQuiz(quizId, parsed.data, {
      userId: req.userId,
      name: req.user?.name,
    });

    res
      .status(200)
      .json(ApiResponse.success('Quiz updated successfully', { quiz }));
  },
);

// DELETE /api/v1/quizzes/:id  (super_admin only)
export const deleteQuiz = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const { id } = req.params;
    const quizId = Array.isArray(id) ? id[0] : id;
    if (!quizId) {
      throw new ApiError('Quiz ID is required', 400);
    }

    await quizzesService.deleteQuiz(quizId, {
      userId: req.userId,
      name: req.user?.name,
    });

    res.status(200).json(ApiResponse.success('Quiz deleted successfully'));
  },
);

// POST /api/v1/quizzes/:id/check-answer (accessible by any authenticated employee)
export const checkAnswer = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const quizId = Array.isArray(id) ? id[0] : id;
    if (!quizId) {
      throw new ApiError('Quiz ID is required', 400);
    }

    const parsed = checkAnswerInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }

    const result = await quizzesService.checkQuizAnswer(quizId, parsed.data);

    res
      .status(200)
      .json(ApiResponse.success('Answer checked successfully', result));
  },
);

// POST /api/v1/quizzes/:id/check-answers (Batch check all quiz questions in 1 call)
export const checkBatchAnswers = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const quizId = Array.isArray(id) ? id[0] : id;
    if (!quizId) {
      throw new ApiError('Quiz ID is required', 400);
    }

    const parsed = checkBatchAnswersInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }

    const result = await quizzesService.checkQuizBatchAnswers(
      quizId,
      parsed.data,
    );

    res
      .status(200)
      .json(ApiResponse.success('Answers checked successfully', result));
  },
);

// POST /api/v1/quizzes/generate-from-procedure
export const generateQuizFromProcedure = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const parsed = generateQuizInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }

    let procedureInput = parsed.data.procedure;

    if (!procedureInput && parsed.data.procedureId) {
      const [row] = await db
        .select()
        .from(procedures)
        .where(eq(procedures.id, parsed.data.procedureId))
        .limit(1);

      if (!row) {
        throw new ApiError('Procedure not found', 404, true, '', {
          code: 'PROCEDURE_NOT_FOUND',
        });
      }

      const bodyEn = parseStoredBody(row.blocksEn, `${row.id}/blocksEn`);

      procedureInput = {
        titleEn: row.titleEn,
        titleEs: row.titleEs,
        purposeEn: row.purposeEn || '',
        purposeEs: row.purposeEs || '',
        blocks: bodyEn.blocks as unknown as Array<Record<string, unknown>>,
        ingredients: [],
      };
    }

    if (!procedureInput) {
      throw new ApiError(
        'Procedure content is required to generate quiz',
        400,
        true,
        '',
        {
          code: 'PROCEDURE_REQUIRED',
        },
      );
    }

    const result = await quizAiService.generateQuizFromProcedure(
      procedureInput,
      parsed.data.config,
    );

    res
      .status(200)
      .json(ApiResponse.success('Quiz generated successfully', result));
  },
);

// POST /api/v1/quizzes/generate-from-chapter
export const generateQuizFromChapter = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const parsed = generateChapterQuizInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }

    let chapterInput = parsed.data.chapter;

    if (!chapterInput && parsed.data.chapterId) {
      const [chRow] = await db
        .select()
        .from(trainingChapters)
        .where(eq(trainingChapters.id, parsed.data.chapterId))
        .limit(1);

      if (!chRow) {
        throw new ApiError('Chapter not found', 404, true, '', {
          code: 'CHAPTER_NOT_FOUND',
        });
      }

      // Fetch course name
      const [cRow] = await db
        .select()
        .from(trainingCourses)
        .where(eq(trainingCourses.id, chRow.courseId))
        .limit(1);

      chapterInput = {
        courseId: chRow.courseId,
        courseName: cRow?.titleEn || '',
        chapterNumber: chRow.number,
        titleEn: chRow.titleEn,
        titleEs: chRow.titleEs,
        purposeEn: chRow.subtitleEn || '',
        purposeEs: chRow.subtitleEs || '',
        procedureId: chRow.procedureId || undefined,
        blocks: Array.isArray(chRow.blocks)
          ? (chRow.blocks as Array<Record<string, unknown>>)
          : [],
      };
    }

    if (!chapterInput) {
      throw new ApiError(
        'Chapter content is required to generate quiz',
        400,
        true,
        '',
        {
          code: 'CHAPTER_REQUIRED',
        },
      );
    }

    const result = await quizAiService.generateQuizFromChapter(
      chapterInput,
      parsed.data.config,
    );

    res
      .status(200)
      .json(ApiResponse.success('Quiz generated successfully', result));
  },
);
