import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import type { Request, Response } from 'express';
import {
  statusEnum,
  createSchema,
  updateSchema,
  idParam,
} from '../../shared/validations/employees.schema.ts';
import { SQL, and, eq, count, ilike, or, inArray, desc } from 'drizzle-orm';
import {
  getPaginationParams,
  formatPaginatedResult,
} from '../../shared/utils/pagination.ts';
import { db } from '../../db/client.ts';
import {
  employees,
  locations,
  session,
  jobs,
  stations,
} from '../../db/index.ts';

import {
  sendInviteMagicLink,
  getActiveInviteUrl,
  createEmployeeTransaction,
  updateEmployeeTransaction,
} from '../../services/employee/employee.service.ts';

import { listEmployeeTraining } from '../../services/courses/course-assignments.service.ts';

import catchAsync from '../../shared/utils/catchAsync.ts';

// ============================================================================
// Employees CRUD (existing)
// ============================================================================

// ---------- POST /api/admin/employees --------------------------------------
export const createEmployee = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const adminId = req.userId || req.employee?.id;
    if (!adminId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    const input = parsed.data;

    const { employee: row } = await createEmployeeTransaction(input, adminId);

    // Send magic link invite email — Better Auth handles token generation.
    const inviteUrl = await sendInviteMagicLink({
      email: row.email,
      name: row.name,
      languagePref: row.languagePref,
    });

    const employeeResponse = await buildEmployeeResponse(row);

    res.status(201).json(
      ApiResponse.success('Employee created and invite sent', {
        employee: employeeResponse,
        inviteUrl,
      }),
    );
  },
);

// ---------- POST /api/admin/employees/:id/invites --------------------------
export const resendInvite = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const param = idParam.safeParse(req.params);
    if (!param.success) {
      throw new ApiError('Invalid employee id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const [employee] = await db
      .select()
      .from(employees)
      .where(eq(employees.id, param.data.id))
      .limit(1);
    if (!employee) {
      throw new ApiError('Employee not found', 404, true, '', {
        code: 'EMPLOYEE_NOT_FOUND',
      });
    }
    if (employee.status !== 'pending') {
      res.status(409).json({
        error: {
          code: 'EMPLOYEE_NOT_PENDING',
          message: 'Only pending employees can be re-invited.',
        },
      });
      return;
    }

    // Better Auth automatically invalidates the old token when a new
    // magic link is requested for the same email (verification table
    // entries expire; new one replaces semantics via TTL).
    const inviteUrl = await sendInviteMagicLink({
      email: employee.email,
      name: employee.name,
      languagePref: employee.languagePref,
    });

    res
      .status(200)
      .json(ApiResponse.success('Invite resent successfully', { inviteUrl }));
  },
);

// ---------- POST /api/admin/employees/:id/deactivate -----------------------
export const deactivate = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const param = idParam.safeParse(req.params);
    if (!param.success) {
      throw new ApiError('Invalid employee id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const [employee] = await db
      .select()
      .from(employees)
      .where(eq(employees.id, param.data.id))
      .limit(1);
    if (!employee) {
      throw new ApiError('Employee not found', 404, true, '', {
        code: 'EMPLOYEE_NOT_FOUND',
      });
    }
    if (employee.status === 'deactivated') {
      res.status(409).json({
        error: {
          code: 'ALREADY_DEACTIVATED',
          message: 'Employee is already deactivated.',
        },
      });
      return;
    }

    await db.transaction(async (tx) => {
      await tx
        .update(employees)
        .set({ status: 'deactivated', deactivatedAt: new Date() })
        .where(eq(employees.id, employee.id));
      // Kill every active Better Auth session for this employee. If the
      // employee never activated, employees.userId is null and this is a no-op.
      if (employee.userId) {
        await tx.delete(session).where(eq(session.userId, employee.userId));
      }
    });

    const [updated] = await db
      .select()
      .from(employees)
      .where(eq(employees.id, employee.id))
      .limit(1);
    const employeeResponse = await buildEmployeeResponse(updated!);
    res.status(200).json(
      ApiResponse.success('Employee deactivated successfully', {
        employee: employeeResponse,
      }),
    );
  },
);

// ---------- POST /api/admin/employees/:id/reactivate ----------------------
export const reactivate = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const param = idParam.safeParse(req.params);
    if (!param.success) {
      throw new ApiError('Invalid employee id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const [employee] = await db
      .select()
      .from(employees)
      .where(eq(employees.id, param.data.id))
      .limit(1);
    if (!employee) {
      throw new ApiError('Employee not found', 404, true, '', {
        code: 'EMPLOYEE_NOT_FOUND',
      });
    }
    if (employee.status !== 'deactivated') {
      res.status(409).json({
        error: {
          code: 'NOT_DEACTIVATED',
          message: 'Employee is not deactivated.',
        },
      });
      return;
    }

    await db
      .update(employees)
      .set({ status: 'active', deactivatedAt: null })
      .where(eq(employees.id, employee.id));

    const [updated] = await db
      .select()
      .from(employees)
      .where(eq(employees.id, employee.id))
      .limit(1);
    const employeeResponse = await buildEmployeeResponse(updated!);
    res.status(200).json(
      ApiResponse.success('Employee reactivated successfully', {
        employee: employeeResponse,
      }),
    );
  },
);

// ---------- GET /api/admin/employees?status=... ----------------------------
export const listEmployees = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { page, limit, offset, search } = getPaginationParams(req.query);
    const q = statusEnum.safeParse(req.query.status ?? 'all');
    const status = q.success ? q.data : 'all';

    const conditions: SQL[] = [];
    if (status !== 'all') {
      conditions.push(eq(employees.status, status));
    }
    if (search) {
      conditions.push(
        or(
          ilike(employees.name, `%${search}%`),
          ilike(employees.email, `%${search}%`),
        )!,
      );
    }
    const whereClause = conditions.length ? and(...conditions) : undefined;

    const rows = await db
      .select({
        employee: employees,
        locationName: locations.name,
      })
      .from(employees)
      .leftJoin(locations, eq(locations.id, employees.locationId))
      .where(whereClause)
      .orderBy(desc(employees.createdAt))
      .limit(limit)
      .offset(offset);

    const [countRes] = await db
      .select({ total: count() })
      .from(employees)
      .where(whereClause);

    const allJobIds = rows.flatMap((r) => r.employee.jobIds || []);
    const allStationIds = rows.flatMap((r) => r.employee.stationIds || []);

    const { jobMap, stationMap } = await getJobsAndStationsMap(
      allJobIds,
      allStationIds,
    );

    const mappedEmployees = rows.map((r) => {
      const resolvedJobs = (r.employee.jobIds || [])
        .map((id) => jobMap.get(id))
        .filter((j): j is { id: string; name: string } => Boolean(j));

      const resolvedStations = (r.employee.stationIds || [])
        .map((id) => stationMap.get(id))
        .filter((s): s is { id: string; name: string } => Boolean(s));

      return {
        ...publicEmployee(r.employee),
        locationName: r.locationName,
        roleName: r.employee.role,
        jobs: resolvedJobs,
        stations: resolvedStations,
      };
    });

    res.status(200).json(
      ApiResponse.success('Employees retrieved successfully', {
        employees: mappedEmployees,
        meta: formatPaginatedResult(
          mappedEmployees,
          countRes?.total ?? 0,
          page,
          limit,
        ).meta,
      }),
    );
  },
);

// ---------- GET /api/admin/employees/:id -----------------------------------
export const getEmployee = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const param = idParam.safeParse(req.params);
    if (!param.success) {
      throw new ApiError('Invalid employee id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const [row] = await db
      .select({
        employee: employees,
        locationName: locations.name,
      })
      .from(employees)
      .leftJoin(locations, eq(locations.id, employees.locationId))
      .where(eq(employees.id, param.data.id))
      .limit(1);

    if (!row) {
      throw new ApiError('Employee not found', 404, true, '', {
        code: 'EMPLOYEE_NOT_FOUND',
      });
    }

    const employeeResponse = await buildEmployeeResponse(
      row.employee,
      row.locationName,
    );

    let inviteUrl: string | undefined = undefined;
    if (row.employee.status === 'pending') {
      inviteUrl = await getActiveInviteUrl(
        row.employee.email,
        row.employee.languagePref,
      );
    }

    res.status(200).json(
      ApiResponse.success('Employee retrieved successfully', {
        employee: {
          ...employeeResponse,
          ...(inviteUrl ? { inviteUrl } : {}),
        },
        ...(inviteUrl ? { inviteUrl } : {}),
      }),
    );
  },
);

// ---------- GET /api/admin/employees/:id/training ---------------------------
// Every training course assigned to this employee, with its current state.
// Reuses the same assignment query the employee-side "my training" list is
// built on, but addressed by employee id in the URL so admins can fetch it
// for anyone (employees route is already super_admin-gated).
export const getEmployeeTraining = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const param = idParam.safeParse(req.params);
    if (!param.success) {
      throw new ApiError('Invalid employee id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const [employee] = await db
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      .where(eq(employees.id, param.data.id))
      .limit(1);
    if (!employee) {
      throw new ApiError('Employee not found', 404, true, '', {
        code: 'EMPLOYEE_NOT_FOUND',
      });
    }

    const rows = await listEmployeeTraining(param.data.id);

    const todayStart = new Date().setHours(0, 0, 0, 0);
    const assignments = rows.map((r) => {
      const completed = r.courseCompletedAt !== null;
      const isOverdue =
        !completed && new Date(r.dueDate).getTime() < todayStart;
      // Four-state status the admin UI expects: a course still `due` when
      // nothing is done yet, `in_progress` once chapters are completed,
      // `complete` when finished, `overdue` when past due unfinished.
      const status = completed
        ? 'complete'
        : isOverdue
          ? 'overdue'
          : r.completedChapterCount > 0
            ? 'in_progress'
            : 'due';

      return {
        assignmentId: r.assignmentId,
        courseId: r.courseId,
        titleEn: r.titleEn,
        titleEs: r.titleEs,
        purposeEn: r.purposeEn,
        purposeEs: r.purposeEs,
        courseStatus: r.courseStatus,
        dueDate: r.dueDate,
        assignedAt: r.assignedAt.toISOString(),
        currentChapterId: r.currentChapterId,
        currentChapterNumber: r.currentChapterNumber,
        currentChapterTitleEn: r.currentChapterTitleEn,
        currentChapterTitleEs: r.currentChapterTitleEs,
        courseCompletedAt: r.courseCompletedAt
          ? r.courseCompletedAt.toISOString()
          : null,
        chapterCount: r.chapterCount,
        completedChapterCount: r.completedChapterCount,
        progressPercent: r.progressPercent,
        status,
      };
    });

    res.status(200).json(
      ApiResponse.success('Employee training retrieved successfully', {
        employee: { id: employee.id, name: employee.name },
        assignments,
      }),
    );
  },
);

// ---------- PATCH /api/admin/employees/:id ---------------------------------
export const updateEmployee = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const adminId = req.userId || req.employee?.id;
    if (!adminId) {
      throw new ApiError('Not authenticated', 401, true, '', {
        code: 'UNAUTHENTICATED',
      });
    }

    const param = idParam.safeParse(req.params);
    if (!param.success) {
      throw new ApiError('Invalid employee id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw parsed.error;
    }

    const [existing] = await db
      .select({
        email: employees.email,
        userId: employees.userId,
        status: employees.status,
      })
      .from(employees)
      .where(eq(employees.id, param.data.id))
      .limit(1);

    const { employee: updated } = await updateEmployeeTransaction(
      param.data.id,
      parsed.data,
      adminId,
    );

    let inviteUrl: string | undefined = undefined;
    if (
      existing &&
      existing.email !== updated.email &&
      (!updated.userId || updated.status === 'pending')
    ) {
      inviteUrl = await sendInviteMagicLink({
        email: updated.email,
        name: updated.name,
        languagePref: updated.languagePref,
      });
    }

    const employeeResponse = await buildEmployeeResponse(updated);

    res.status(200).json(
      ApiResponse.success('Employee updated successfully', {
        employee: employeeResponse,
        ...(inviteUrl ? { inviteUrl } : {}),
      }),
    );
  },
);

// ============================================================================
// Shared helpers
// ============================================================================

export function publicEmployee(e: Readonly<typeof employees.$inferSelect>) {
  return {
    id: e.id,
    name: e.name,
    email: e.email,
    employeeCode: e.employeeCode,
    locationId: e.locationId,
    role: e.role,
    languagePref: e.languagePref,
    status: e.status,
    createdAt: e.createdAt.toISOString(),
    deactivatedAt: e.deactivatedAt ? e.deactivatedAt.toISOString() : null,
  };
}

export async function getJobsAndStationsMap(
  jobIds: (string | null | undefined)[],
  stationIds: (string | null | undefined)[],
) {
  const uniqueJobIds = [
    ...new Set(jobIds.filter((id): id is string => Boolean(id))),
  ];
  const uniqueStationIds = [
    ...new Set(stationIds.filter((id): id is string => Boolean(id))),
  ];

  const [jobRows, stationRows] = await Promise.all([
    uniqueJobIds.length > 0
      ? db
          .select({ id: jobs.id, name: jobs.name })
          .from(jobs)
          .where(inArray(jobs.id, uniqueJobIds))
      : Promise.resolve([]),
    uniqueStationIds.length > 0
      ? db
          .select({ id: stations.id, name: stations.name })
          .from(stations)
          .where(inArray(stations.id, uniqueStationIds))
      : Promise.resolve([]),
  ]);

  const jobMap = new Map<string, { id: string; name: string }>();
  for (const j of jobRows) {
    jobMap.set(j.id, { id: j.id, name: j.name });
  }

  const stationMap = new Map<string, { id: string; name: string }>();
  for (const s of stationRows) {
    stationMap.set(s.id, { id: s.id, name: s.name });
  }

  return { jobMap, stationMap };
}

export async function buildEmployeeResponse(
  employee: typeof employees.$inferSelect,
  locationName?: string | null,
) {
  let locName = locationName;
  if (locName === undefined && employee.locationId) {
    const [loc] = await db
      .select({ name: locations.name })
      .from(locations)
      .where(eq(locations.id, employee.locationId))
      .limit(1);
    locName = loc?.name ?? null;
  }

  const { jobMap, stationMap } = await getJobsAndStationsMap(
    employee.jobIds || [],
    employee.stationIds || [],
  );

  const resolvedJobs = (employee.jobIds || [])
    .map((id) => jobMap.get(id))
    .filter((j): j is { id: string; name: string } => Boolean(j));

  const resolvedStations = (employee.stationIds || [])
    .map((id) => stationMap.get(id))
    .filter((s): s is { id: string; name: string } => Boolean(s));

  return {
    ...publicEmployee(employee),
    locationName: locName ?? null,
    roleName: employee.role,
    jobs: resolvedJobs,
    stations: resolvedStations,
  };
}
