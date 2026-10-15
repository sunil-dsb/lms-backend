import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import type { Request, Response } from 'express';
import {
  slugIdParam,
  jobCreateSchema,
  jobPatchSchema,
} from '../../shared/validations/employees.schema.ts';
import * as jobsService from '../../services/job/jobs.service.ts';
import catchAsync from '../../shared/utils/catchAsync.ts';
import { getPaginationParams } from '../../shared/utils/pagination.ts';

export const listJobs = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { page, limit, search } = getPaginationParams(req.query);
    const result = await jobsService.listJobs(page, limit, search);
    res.status(200).json(
      ApiResponse.success('Jobs retrieved successfully', {
        jobs: result.items,
        meta: result.meta,
      }),
    );
  },
);

// GET /api/v1/jobs/with-stations?role=<role>
// Used by the employee form: returns jobs for a role, each with their stations.
// Requires auth (any employee), but NOT admin-only.

// QUERY /api/v1/jobs/stations
// Returns the stations linked to multiple jobs, using a query parameter or body payload.
// Useful when the frontend fetches stations on-demand for selected jobs.
export const getJobStations = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    let jobIds: string[] = [];
    const inputJobIds = req.body?.jobIds || req.query.jobIds;

    if (typeof inputJobIds === 'string') {
      jobIds = inputJobIds
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    } else if (Array.isArray(inputJobIds)) {
      jobIds = inputJobIds.map((id) => String(id).trim()).filter(Boolean);
    }

    if (jobIds.length === 0) {
      res
        .status(200)
        .json(ApiResponse.success('Stations retrieved', { stations: [] }));
      return;
    }

    const stationsList = await jobsService.getJobStations(jobIds);
    res
      .status(200)
      .json(
        ApiResponse.success('Stations retrieved', { stations: stationsList }),
      );
  },
);

export const createJob = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId)
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    const parsed = jobCreateSchema.safeParse(req.body);
    if (!parsed.success) throw parsed.error;
    const job = await jobsService.createJob(parsed.data);
    res
      .status(201)
      .json(ApiResponse.success('Job created successfully', { job }));
  },
);

export const updateJob = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId)
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    const param = slugIdParam.safeParse(req.params);
    if (!param.success)
      throw new ApiError('Invalid job id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    const patch = jobPatchSchema.safeParse(req.body);
    if (!patch.success) throw patch.error;
    const job = await jobsService.updateJob(param.data.id, patch.data);
    res
      .status(200)
      .json(ApiResponse.success('Job updated successfully', { job }));
  },
);

export const deleteJob = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId)
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    const param = slugIdParam.safeParse(req.params);
    if (!param.success)
      throw new ApiError('Invalid job id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    await jobsService.deleteJob(param.data.id);
    res
      .status(200)
      .json(ApiResponse.success('Job deleted successfully', { ok: true }));
  },
);
