import type { Request, Response } from 'express';
import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import catchAsync from '../../shared/utils/catchAsync.ts';
import { reorderChaptersInputSchema } from '../../db/index.ts';
import * as chaptersService from '../../services/courses/chapters.service.ts';
import { z } from 'zod';

const uuidParamSchema = z.string().uuid('Invalid UUID format');

function validateUuid(id: string, name: string): string {
  const result = uuidParamSchema.safeParse(id);
  if (!result.success) {
    throw new ApiError(`Invalid ${name} format`, 400, true, '', {
      code: 'INVALID_INPUT',
    });
  }
  return result.data;
}

// GET /api/v1/chapters or GET /api/v1/courses/:courseId/chapters
export const listChapters = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const rawCourseId =
      (req.params.courseId as string | undefined) ||
      (req.query.courseId as string | undefined);

    let courseId: string | undefined = undefined;
    if (rawCourseId) {
      courseId = validateUuid(rawCourseId, 'course ID');
    }

    const chapters = await chaptersService.listChapters(courseId);

    res.status(200).json(
      ApiResponse.success('Course chapters retrieved successfully', {
        chapters,
      }),
    );
  },
);

// GET /api/v1/chapters/:id or GET /api/v1/courses/:courseId/chapters/:id
export const getChapter = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const rawId = (req.params.id as string) || (req.params.chapterId as string);
    const rawCourseId =
      (req.params.courseId as string | undefined) ||
      (req.query.courseId as string | undefined);

    const isNumeric = /^\d+$/.test(rawId);
    let chapterId = rawId;
    let courseId: string | undefined = undefined;

    if (rawCourseId) {
      courseId = validateUuid(rawCourseId, 'course ID');
    }

    if (!isNumeric) {
      chapterId = validateUuid(rawId, 'chapter ID');
    }

    const chapter = await chaptersService.getChapterById(chapterId, courseId);

    res.status(200).json(
      ApiResponse.success('Course chapter retrieved successfully', {
        chapter,
      }),
    );
  },
);

// PATCH /api/v1/chapters/reorder
export const reorderChapters = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const body = Array.isArray(req.body) ? { orders: req.body } : req.body;
    const parsed = reorderChaptersInputSchema.safeParse(body);
    if (!parsed.success) {
      throw parsed.error;
    }

    const rawCourseId =
      (req.params.courseId as string | undefined) ||
      (req.query.courseId as string | undefined) ||
      parsed.data.courseId;

    if (!rawCourseId) {
      throw new ApiError('courseId is required', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const courseId = validateUuid(rawCourseId, 'course ID');
    const chapters = await chaptersService.reorderChapters(
      courseId,
      parsed.data,
    );

    res.status(200).json(
      ApiResponse.success('Course chapters reordered successfully', {
        chapters,
      }),
    );
  },
);

// DELETE /api/v1/chapters/:id
export const deleteChapter = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const rawId = (req.params.id as string) || (req.params.chapterId as string);
    const chapterId = validateUuid(rawId, 'chapter ID');

    const rawCourseId =
      (req.params.courseId as string | undefined) ||
      (req.query.courseId as string | undefined);
    const courseId = rawCourseId
      ? validateUuid(rawCourseId, 'course ID')
      : undefined;

    await chaptersService.deleteChapter(
      chapterId,
      {
        userId: req.userId,
      },
      courseId,
    );

    res
      .status(200)
      .json(ApiResponse.success('Course chapter deleted successfully', null));
  },
);
