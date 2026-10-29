import type { Request, Response } from 'express';
import catchAsync from '../../shared/utils/catchAsync.ts';
import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import {
  createQuizInputSchema,
  updateQuizInputSchema,
} from '../../db/quiz.schema.ts';
import * as quizzesService from '../../services/quiz/quiz.service.ts';
import { getPaginationParams } from '../../shared/utils/pagination.ts';

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

    const quiz = await quizzesService.updateQuiz(quizId, parsed.data);

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

    await quizzesService.deleteQuiz(quizId);

    res.status(200).json(ApiResponse.success('Quiz deleted successfully'));
  },
);
