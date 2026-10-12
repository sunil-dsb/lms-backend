import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import type { Request, Response } from 'express';

import * as proceduresService from '../../services/procedures/procedures.service.ts';
import { getPaginationParams } from '../../shared/utils/pagination.ts';
import {
  procedureStatuses,
  type ProcedureStatus,
} from '../../db/procedure.schema.ts';
import {
  createProcedureInputSchema,
  updateProcedureInputSchema,
} from '../../db/procedure.schema.ts';
import catchAsync from '../../shared/utils/catchAsync.ts';
import { z } from 'zod';

const updateStationsSchema = z.object({
  stationIds: z.array(z.string().uuid()).nullable().optional(),
  stationId: z.string().uuid().nullable().optional(),
});

// ============================================================================
// Procedures
// ============================================================================

// POST /api/admin/library/procedures
export const createProcedure = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.employee) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const parsed = createProcedureInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }

    const procedure = await proceduresService.createProcedure(parsed.data, {
      employeeId: req.employee.id,
      userId: req.employee.userId,
    });
    res
      .status(201)
      .json(
        ApiResponse.success('Procedure created successfully', { procedure }),
      );
  },
);

// PUT /api/v1/procedures/:id
export const updateProcedure = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.employee) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new ApiError('Missing procedure id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const parsed = updateProcedureInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }

    const procedure = await proceduresService.updateProcedure(id, parsed.data);
    res
      .status(200)
      .json(
        ApiResponse.success('Procedure updated successfully', { procedure }),
      );
  },
);

// GET /api/v1/procedures
export const getAllProcedures = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { page, limit, search } = getPaginationParams(req.query);

    if (!req.employee) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const paginatedResult = await proceduresService.listProcedures(
      { search },
      page,
      limit,
    );
    res.status(200).json(
      ApiResponse.success('Procedures retrieved successfully', {
        procedures: paginatedResult.items,
        meta: paginatedResult.meta,
      }),
    );
  },
);

// GET /api/v1/procedures/assigned
export const getAssignedProcedures = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.employee) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const { page, limit, search } = getPaginationParams(req.query);
    const stationIds = req.employee.stationIds || [];
    const scope = typeof req.query.scope === 'string' ? req.query.scope : 'all';
    const categoryId =
      typeof req.query.categoryId === 'string' &&
      req.query.categoryId.trim().length > 0
        ? req.query.categoryId.trim()
        : undefined;

    const isAdmin =
      Boolean(req.isSuperAdmin) ||
      req.employee.role === 'super_admin' ||
      req.employee.role === 'manager';

    const paginatedResult = await proceduresService.listProcedures(
      {
        status: 'published',
        stationIds,
        assignedEmployeeId: !isAdmin ? req.employee.id || undefined : undefined,
        scope,
        categoryIds: categoryId ? [categoryId] : undefined,
        search,
      },
      page,
      limit,
    );

    res.status(200).json(
      ApiResponse.success('Assigned procedures retrieved successfully', {
        procedures: paginatedResult.items,
        meta: paginatedResult.meta,
      }),
    );
  },
);

// GET /api/v1/procedures/filter
export const filterProcedures = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.employee) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    // -- status filter --
    const raw = req.query.status;
    let status: ProcedureStatus | undefined;
    if (typeof raw === 'string' && raw.length > 0) {
      if (!procedureStatuses.includes(raw as ProcedureStatus)) {
        res.status(400).json({
          error: {
            code: 'INVALID_INPUT',
            message: 'Invalid status filter',
            details: [
              {
                path: 'status',
                message: `Expected one of ${procedureStatuses.join(', ')}`,
              },
            ],
          },
        });
        return;
      }
      status = raw as ProcedureStatus;
    }

    // -- array filters --
    const parseUuidList = (param: unknown): string[] | undefined => {
      const raw = Array.isArray(param) ? param.join(',') : param;
      if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    };

    const stationIds = parseUuidList(req.query.stationIds);
    const subcategoryIds = parseUuidList(req.query.subcategoryIds);
    const categoryIds = parseUuidList(req.query.categoryIds);

    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const validateUuids = (ids: string[] | undefined, name: string) => {
      if (ids && ids.some((id) => !uuidRegex.test(id))) {
        return { error: `${name} must be valid UUIDs` };
      }
      return null;
    };

    for (const [ids, name] of [
      [stationIds, 'stationIds'],
      [subcategoryIds, 'subcategoryIds'],
      [categoryIds, 'categoryIds'],
    ] as const) {
      const err = validateUuids(ids, name);
      if (err) {
        res.status(400).json({
          error: {
            code: 'INVALID_INPUT',
            message: err.error,
          },
        });
        return;
      }
    }

    const { page, limit, search } = getPaginationParams(req.query);

    // -- categoryType filter (e.g. 'general' or station-based types) --
    const rawType = req.query.categoryType;
    const categoryType =
      typeof rawType === 'string' && rawType.trim().length > 0
        ? rawType.trim().slice(0, 100)
        : undefined;

    const paginatedResult = await proceduresService.listProcedures(
      {
        status,
        stationIds,
        subcategoryIds,
        categoryIds,
        categoryType,
        search,
      },
      page,
      limit,
    );
    res.status(200).json(
      ApiResponse.success('Filtered procedures retrieved successfully', {
        procedures: paginatedResult.items,
        meta: paginatedResult.meta,
      }),
    );
  },
);

// GET /api/procedures/:slug  (public read â€” any logged-in employee)
export const getProcedure = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.employee) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const slug = req.params.slug;
    if (typeof slug !== 'string' || slug.length === 0) {
      throw new ApiError('Missing procedure slug', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const procedure = await proceduresService.getProcedureBySlug(slug, {
      role: req.employee.role,
      employeeId: req.employee.id,
      isSuperAdmin: req.isSuperAdmin,
    });
    if (!procedure) {
      throw new ApiError('Procedure not found', 404, true, '', {
        code: 'NOT_FOUND',
      });
    }
    res
      .status(200)
      .json(
        ApiResponse.success('Procedure retrieved successfully', { procedure }),
      );
  },
);
// POST /api/v1/procedures/:id/publish  (super_admin only)
export const publishProcedure = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.employee) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new ApiError('Missing procedure id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const procedure = await proceduresService.publishProcedure(id);
    res
      .status(200)
      .json(
        ApiResponse.success('Procedure published successfully', { procedure }),
      );
  },
);

// PATCH /api/v1/procedures/:id/station (super_admin only, single stationId)
export const updateProcedureStations = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.employee) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new ApiError('Missing procedure id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }
    const parsed = updateStationsSchema.safeParse(req.body);
    if (!parsed.success) throw parsed.error;
    const ids =
      parsed.data.stationIds ??
      (parsed.data.stationId ? [parsed.data.stationId] : null);
    const procedure = await proceduresService.updateProcedureStations(id, ids);
    res.status(200).json(
      ApiResponse.success('Procedure station updated successfully', {
        procedure,
      }),
    );
  },
);

// POST /api/v1/procedures/:id/archive  (super_admin only)
export const archiveProcedure = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.employee) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new ApiError('Missing procedure id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const procedure = await proceduresService.archiveProcedure(id);
    res
      .status(200)
      .json(
        ApiResponse.success('Procedure archived successfully', { procedure }),
      );
  },
);

// POST /api/v1/procedures/:id/unarchive  (super_admin only)
export const unarchiveProcedure = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.employee) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new ApiError('Missing procedure id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const procedure = await proceduresService.unarchiveProcedure(id);
    res
      .status(200)
      .json(
        ApiResponse.success('Procedure unarchived successfully', { procedure }),
      );
  },
);
