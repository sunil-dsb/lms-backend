import type { Request, Response } from 'express';
import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import catchAsync from '../../shared/utils/catchAsync.ts';
import { getPaginationParams } from '../../shared/utils/pagination.ts';
import {
  createCourseInputSchema,
  updateCourseInputSchema,
  type TrainingCourseStatus,
} from '../../db/index.ts';
import * as coursesService from '../../services/courses/courses.service.ts';
import { z } from 'zod';

const uuidParamSchema = z.string().uuid('Invalid course ID');

// GET /api/v1/courses
export const listCourses = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { page, limit } = getPaginationParams(
      req.query as Record<string, unknown>,
    );
    const search =
      typeof req.query.search === 'string' ? req.query.search : undefined;
    const statusParam =
      typeof req.query.status === 'string'
        ? req.query.status.toLowerCase().trim()
        : undefined;

    let status: TrainingCourseStatus | undefined = undefined;
    if (statusParam === 'published' || statusParam === 'publish') {
      status = 'published';
    } else if (statusParam === 'archived' || statusParam === 'archive') {
      status = 'archived';
    }

    const result = await coursesService.listCourses({
      search,
      status,
      page,
      limit,
    });

    res
      .status(200)
      .json(
        ApiResponse.success('Training courses retrieved successfully', result),
      );
  },
);

// GET /api/v1/courses/:id
export const getCourse = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const idValidation = uuidParamSchema.safeParse(req.params.id);
    if (!idValidation.success) {
      throw new ApiError('Invalid course id format', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const course = await coursesService.getCourseById(idValidation.data);
    res.status(200).json(
      ApiResponse.success('Training course retrieved successfully', {
        course,
      }),
    );
  },
);

// POST /api/v1/courses
export const createCourse = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const parsed = createCourseInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }

    const course = await coursesService.createCourse(parsed.data, {
      userId: req.userId,
    });

    res
      .status(201)
      .json(
        ApiResponse.success('Training course created successfully', { course }),
      );
  },
);

// PUT /api/v1/courses/:id or PATCH /api/v1/courses/:id
export const updateCourse = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const idValidation = uuidParamSchema.safeParse(req.params.id);
    if (!idValidation.success) {
      throw new ApiError('Invalid course id format', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const parsed = updateCourseInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }

    const course = await coursesService.updateCourse(
      idValidation.data,
      parsed.data,
      {
        userId: req.userId,
      },
    );

    res
      .status(200)
      .json(
        ApiResponse.success('Training course updated successfully', { course }),
      );
  },
);

// POST /api/v1/courses/:id/archive
export const archiveCourse = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const idValidation = uuidParamSchema.safeParse(req.params.id);
    if (!idValidation.success) {
      throw new ApiError('Invalid course id format', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const course = await coursesService.archiveCourse(idValidation.data);
    res.status(200).json(
      ApiResponse.success('Training course archived successfully', {
        course,
      }),
    );
  },
);

// POST /api/v1/courses/:id/unarchive
export const unarchiveCourse = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const idValidation = uuidParamSchema.safeParse(req.params.id);
    if (!idValidation.success) {
      throw new ApiError('Invalid course id format', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const course = await coursesService.unarchiveCourse(idValidation.data);
    res.status(200).json(
      ApiResponse.success('Training course restored successfully', {
        course,
      }),
    );
  },
);

// DELETE /api/v1/courses/:id
export const deleteCourse = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const idValidation = uuidParamSchema.safeParse(req.params.id);
    if (!idValidation.success) {
      throw new ApiError('Invalid course id format', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    await coursesService.deleteCourse(idValidation.data);
    res
      .status(200)
      .json(ApiResponse.success('Training course deleted successfully', null));
  },
);
