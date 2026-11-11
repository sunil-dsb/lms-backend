import type { Request, Response } from 'express';
import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import catchAsync from '../../shared/utils/catchAsync.ts';
import { getPaginationParams } from '../../shared/utils/pagination.ts';
import {
  createCourseInputSchema,
  updateCourseInputSchema,
  assignCourseInputSchema,
  unassignCourseInputSchema,
  type TrainingCourseStatus,
} from '../../db/index.ts';
import * as coursesService from '../../services/courses/courses.service.ts';
import * as courseAssignmentsService from '../../services/courses/course-assignments.service.ts';
import * as courseProgressService from '../../services/courses/course-progress.service.ts';
import { z } from 'zod';

const uuidParamSchema = z.string().uuid('Invalid course ID');

function requireEmployeeId(req: Request): string {
  if (!req.employee?.id) {
    throw new ApiError('Employee account is required', 403, true, '', {
      code: 'EMPLOYEE_REQUIRED',
    });
  }
  return req.employee.id;
}

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

    const assignmentParam =
      typeof req.query.assignment === 'string'
        ? req.query.assignment.toLowerCase().trim()
        : undefined;

    let assignment: 'all' | 'assigned' | 'unassigned' | undefined = undefined;
    if (assignmentParam === 'assigned') {
      assignment = 'assigned';
    } else if (assignmentParam === 'unassigned') {
      assignment = 'unassigned';
    } else if (assignmentParam === 'all') {
      assignment = 'all';
    }

    const employeeCourseIds = req.employee
      ? (
          await courseAssignmentsService.listAvailableEmployeeTraining(
            req.employee.id,
          )
        ).assignments.map((assignment) => assignment.courseId)
      : undefined;

    const result = await coursesService.listCourses({
      search,
      status,
      assignment,
      employeeCourseIds,
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

// GET /api/v1/courses/my-training
export const listMyTraining = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const training =
      await courseAssignmentsService.listAvailableEmployeeTraining(
        requireEmployeeId(req),
      );
    res.status(200).json(
      ApiResponse.success('Assigned training retrieved successfully', {
        assignments: training.assignments,
        requiredTraining: training.requiredTraining,
      }),
    );
  },
);

// GET /api/v1/courses/my-training/:courseId
export const getMyTrainingCourse = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const courseId = uuidParamSchema.safeParse(req.params.courseId);
    if (!courseId.success) {
      throw new ApiError('Invalid course id format', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }
    const result = await courseAssignmentsService.getEmployeeTrainingCourse(
      courseId.data,
      requireEmployeeId(req),
    );
    res
      .status(200)
      .json(
        ApiResponse.success('Assigned training retrieved successfully', result),
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
    if (req.employee?.id) {
      await courseAssignmentsService.assertEmployeeCanAccessTrainingCourse(
        idValidation.data,
        req.employee.id,
      );
    }
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

// PATCH /api/v1/courses/:id
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

// POST /api/v1/courses/:id/assign
export const assignCourse = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const idValidation = uuidParamSchema.safeParse(req.params.id);
    if (!idValidation.success) {
      throw new ApiError('Invalid course id format', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    // Support both employeeIds or userIds in body for flexibility
    const body = {
      employeeIds:
        req.body?.employeeIds ||
        req.body?.userIds ||
        (Array.isArray(req.body) ? req.body : []),
      stationIds: req.body?.stationIds,
      dueDate: req.body?.dueDate,
      mode: req.body?.mode || 'add',
      isRequired: req.body?.isRequired,
    };

    const parsed = assignCourseInputSchema.safeParse(body);
    if (!parsed.success) {
      throw parsed.error;
    }

    const result = await courseAssignmentsService.assignCourse(
      idValidation.data,
      parsed.data,
    );

    res
      .status(200)
      .json(
        ApiResponse.success('Training course assigned successfully', result),
      );
  },
);

// POST /api/v1/courses/:id/unassign
export const unassignCourse = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const idValidation = uuidParamSchema.safeParse(req.params.id);
    if (!idValidation.success) {
      throw new ApiError('Invalid course id format', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const employeeIds =
      req.body?.employeeIds ||
      req.body?.userIds ||
      (req.body?.employeeId ? [req.body.employeeId] : undefined) ||
      (req.body?.userId ? [req.body.userId] : undefined) ||
      (Array.isArray(req.body) ? req.body : []);

    const parsed = unassignCourseInputSchema.safeParse({ employeeIds });
    if (!parsed.success) {
      throw parsed.error;
    }

    const result = await courseAssignmentsService.unassignCourse(
      idValidation.data,
      parsed.data,
    );

    res
      .status(200)
      .json(
        ApiResponse.success('Training course unassigned successfully', result),
      );
  },
);

// GET /api/v1/courses/:id/progress — current employee's course position.
export const getMyCourseProgress = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const courseId = uuidParamSchema.safeParse(req.params.id);
    if (!courseId.success) {
      throw new ApiError('Invalid course id format', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }
    if (!req.employee?.id) {
      throw new ApiError('Employee account is required', 403, true, '', {
        code: 'EMPLOYEE_REQUIRED',
      });
    }

    const progress = await courseProgressService.getCourseProgress(
      courseId.data,
      req.employee.id,
    );
    res
      .status(200)
      .json(
        ApiResponse.success('Course progress retrieved successfully', progress),
      );
  },
);

// POST /api/v1/courses/:id/chapters/:chapterId/complete
export const completeCurrentChapter = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const courseId = uuidParamSchema.safeParse(req.params.id);
    const chapterId = uuidParamSchema.safeParse(req.params.chapterId);
    if (!courseId.success || !chapterId.success) {
      throw new ApiError('Invalid course or chapter id format', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }
    if (!req.employee?.id) {
      throw new ApiError('Employee account is required', 403, true, '', {
        code: 'EMPLOYEE_REQUIRED',
      });
    }

    const progress = await courseProgressService.completeCurrentChapter(
      courseId.data,
      chapterId.data,
      req.employee.id,
    );
    res
      .status(200)
      .json(ApiResponse.success('Chapter completed successfully', progress));
  },
);

// GET /api/v1/courses/:id/assignments — Admin: list all assigned employees for a course
export const getCourseAssignments = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const idValidation = uuidParamSchema.safeParse(req.params.id);
    if (!idValidation.success) {
      throw new ApiError('Invalid course id format', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const assignments = await courseAssignmentsService.listCourseAssignments(
      idValidation.data,
    );
    res
      .status(200)
      .json(
        ApiResponse.success(
          'Course assignments retrieved successfully',
          assignments,
        ),
      );
  },
);

// GET /api/v1/courses/admin/progress — Admin: aggregated training progress
export const getTrainingProgress = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const rawStatus = req.query.status;
    const validStatuses = [
      'complete',
      'in_progress',
      'overdue',
      'not_started',
      'due_soon',
    ] as const;
    if (
      rawStatus !== undefined &&
      (typeof rawStatus !== 'string' ||
        !validStatuses.includes(rawStatus as (typeof validStatuses)[number]))
    ) {
      throw new ApiError('Invalid progress status filter', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }
    const rawGroupBy = req.query.groupBy;
    if (
      rawGroupBy !== undefined &&
      rawGroupBy !== 'employee' &&
      rawGroupBy !== 'course'
    ) {
      throw new ApiError('Invalid progress grouping', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }
    const parsePositiveInteger = (
      value: unknown,
      fallback: number,
      maximum: number,
    ): number => {
      if (value === undefined) return fallback;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
        throw new ApiError('Invalid progress pagination', 400, true, '', {
          code: 'INVALID_INPUT',
        });
      }
      return parsed;
    };
    const page = parsePositiveInteger(req.query.page, 1, 1_000_000);
    const limit = parsePositiveInteger(req.query.limit, 25, 100);
    const search =
      typeof req.query.search === 'string' ? req.query.search : undefined;
    const rawIncludeAssignments = req.query.includeAssignments;
    if (
      rawIncludeAssignments !== undefined &&
      rawIncludeAssignments !== 'true' &&
      rawIncludeAssignments !== 'false'
    ) {
      throw new ApiError('Invalid assignment details option', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }
    const data = await courseProgressService.getTrainingProgress({
      ...(typeof rawStatus === 'string'
        ? { status: rawStatus as (typeof validStatuses)[number] }
        : {}),
      ...(rawGroupBy === 'employee' || rawGroupBy === 'course'
        ? { groupBy: rawGroupBy }
        : {}),
      page,
      limit,
      ...(search !== undefined ? { search } : {}),
      includeAssignments: rawIncludeAssignments === 'true',
    });
    res
      .status(200)
      .json(
        ApiResponse.success('Training progress retrieved successfully', data),
      );
  },
);
