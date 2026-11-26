import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import type { Request, Response } from 'express';
import {
  statusEnum,
  createSchema,
  updateSchema,
  idParam,
} from '../../shared/validations/employees.schema.ts';
import {
  SQL,
  and,
  eq,
  count,
  ilike,
  or,
  inArray,
  desc,
  ne,
  sql,
} from 'drizzle-orm';
import {
  getPaginationParams,
  formatPaginatedResult,
} from '../../shared/utils/pagination.ts';
import { db } from '../../db/client.ts';
import { employees, locations } from '../../db/index.ts';

import {
  sendInviteMagicLink,
  getActiveInviteUrl,
  createEmployeeTransaction,
  updateEmployeeTransaction,
  getSupervisorSubordinates,
  getManagerSubordinates,
} from '../../services/employee/employee.service.ts';

import catchAsync from '../../shared/utils/catchAsync.ts';
import {
  publicEmployee,
  getJobsAndStationsMap,
  buildEmployeeResponse,
} from './employee-helpers.ts';

// Re-export helpers for consumers (e.g. auth.controller.ts)
export { publicEmployee, getJobsAndStationsMap, buildEmployeeResponse };

// Re-export training controller
export { getEmployeeTraining } from './employee-training.controller.ts';

// Re-export lifecycle actions (invites, deactivate, reactivate)
export {
  resendInvite,
  deactivate,
  reactivate,
} from './employee-lifecycle.controller.ts';

// Re-export team/hierarchy & role controllers so existing router routes remain seamlessly intact
export {
  getSupervisors,
  getManagers,
  getSubordinates,
  updateSubordinates,
  getOperationalRoles,
} from './employee-team.controller.ts';

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

    // Strict Role-Based Hierarchy Authorization:
    // 1. super_admin: can create manager, supervisor, employee
    // 2. manager: can only create supervisor and employee within their own location
    // 3. supervisor/employee: forbidden
    if (!req.isSuperAdmin) {
      if (req.employee?.role === 'manager') {
        if (input.role === 'manager') {
          throw new ApiError(
            'Managers cannot create other managers.',
            403,
            true,
            '',
            {
              code: 'FORBIDDEN',
            },
          );
        }
        if (input.locationId !== req.employee.locationId) {
          throw new ApiError(
            'Managers can only create employees for their own assigned location.',
            403,
            true,
            '',
            {
              code: 'FORBIDDEN',
            },
          );
        }
      } else {
        throw new ApiError(
          'You do not have permission to invite or create employees.',
          403,
          true,
          '',
          {
            code: 'FORBIDDEN',
          },
        );
      }
    }

    const { employee: row } = await createEmployeeTransaction(input, adminId);

    // Send magic link invite email — Better Auth handles token generation.
    const inviteUrl = await sendInviteMagicLink({
      email: row.email,
      name: row.name,
      languagePref: row.languagePref,
    });

    const employeeResponse = await buildEmployeeResponse(
      row,
      undefined,
      req.isSuperAdmin ? 'super_admin' : req.employee?.role,
    );

    res.status(201).json(
      ApiResponse.success('Employee created and invite sent', {
        employee: employeeResponse,
        inviteUrl,
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

    const baseConditions: SQL[] = [];

    if (typeof req.query.role === 'string' && req.query.role !== 'all') {
      const rawRole = req.query.role.toLowerCase();
      const normalizedRole = rawRole === 'admin' ? 'super_admin' : rawRole;
      const validRoles = ['super_admin', 'manager', 'supervisor', 'employee'];
      if (validRoles.includes(normalizedRole)) {
        baseConditions.push(
          eq(
            employees.role,
            normalizedRole as (typeof employees.$inferSelect)['role'],
          ),
        );
      }
    }
    if (
      typeof req.query.stationId === 'string' &&
      req.query.stationId !== 'all'
    ) {
      baseConditions.push(
        sql`${req.query.stationId} = ANY(${employees.stationIds})`,
      );
    }
    if (typeof req.query.jobId === 'string' && req.query.jobId !== 'all') {
      baseConditions.push(sql`${req.query.jobId} = ANY(${employees.jobIds})`);
    }
    if (search) {
      baseConditions.push(
        or(
          ilike(employees.name, `%${search}%`),
          ilike(employees.email, `%${search}%`),
          ilike(employees.employeeCode, `%${search}%`),
          ilike(employees.role, `%${search}%`),
        )!,
      );
    }

    // Role-based visibility scoping:
    // 1. super_admin: sees all employees
    // 2. manager: sees their direct supervisors + nested employees under them (manager themselves excluded)
    // 3. supervisor: sees their direct subordinates (supervisor themselves excluded)
    if (!req.isSuperAdmin) {
      if (req.employee?.id) {
        baseConditions.push(ne(employees.id, req.employee.id));
      }
      if (req.employee?.role === 'manager') {
        const mySubs = await getManagerSubordinates(req.employee.id);
        const subIds = mySubs
          .map((s) => s.id)
          .filter((id) => id !== req.employee?.id);
        if (subIds.length === 0) {
          res.status(200).json(
            ApiResponse.success('Employees retrieved successfully', {
              employees: [],
              meta: formatPaginatedResult([], 0, page, limit).meta,
              statusCounts: { all: 0, pending: 0, active: 0, deactivated: 0 },
            }),
          );
          return;
        }
        baseConditions.push(inArray(employees.id, subIds));
      } else if (req.employee?.role === 'supervisor') {
        const mySubs = await getSupervisorSubordinates(req.employee.id);
        const subIds = mySubs
          .map((s) => s.id)
          .filter((id) => id !== req.employee?.id);
        if (subIds.length === 0) {
          res.status(200).json(
            ApiResponse.success('Employees retrieved successfully', {
              employees: [],
              meta: formatPaginatedResult([], 0, page, limit).meta,
              statusCounts: { all: 0, pending: 0, active: 0, deactivated: 0 },
            }),
          );
          return;
        }
        baseConditions.push(inArray(employees.id, subIds));
      } else {
        // Standard employee has no subordinates
        res.status(200).json(
          ApiResponse.success('Employees retrieved successfully', {
            employees: [],
            meta: formatPaginatedResult([], 0, page, limit).meta,
            statusCounts: { all: 0, pending: 0, active: 0, deactivated: 0 },
          }),
        );
        return;
      }
    }

    // Filter conditions for the employee page (includes status filter if specified)
    const conditions = [...baseConditions];
    if (status !== 'all') {
      conditions.push(eq(employees.status, status));
    }

    const whereClause = conditions.length ? and(...conditions) : undefined;
    const baseWhereClause = baseConditions.length
      ? and(...baseConditions)
      : undefined;

    // Parallel execution: fetch page rows, count for current status filter, and counts across all statuses
    const [rows, [countRes], statusCountsRows] = await Promise.all([
      db
        .select({
          employee: employees,
          locationName: locations.name,
        })
        .from(employees)
        .leftJoin(locations, eq(locations.id, employees.locationId))
        .where(whereClause)
        .orderBy(desc(employees.createdAt))
        .limit(limit)
        .offset(offset),

      db.select({ total: count() }).from(employees).where(whereClause),

      db
        .select({
          status: employees.status,
          total: count(),
        })
        .from(employees)
        .where(baseWhereClause)
        .groupBy(employees.status),
    ]);

    const statusCounts = {
      all: 0,
      pending: 0,
      active: 0,
      deactivated: 0,
    };
    for (const sc of statusCountsRows) {
      const num = Number(sc.total);
      if (sc.status === 'pending') statusCounts.pending = num;
      if (sc.status === 'active') statusCounts.active = num;
      if (sc.status === 'deactivated') statusCounts.deactivated = num;
    }
    statusCounts.all =
      statusCounts.pending + statusCounts.active + statusCounts.deactivated;

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
          Number(countRes?.total ?? 0),
          page,
          limit,
        ).meta,
        statusCounts,
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

    if (!req.isSuperAdmin) {
      if (req.employee?.role === 'manager') {
        const mySubs = await getManagerSubordinates(req.employee.id);
        const visibleIds = [req.employee.id, ...mySubs.map((s) => s.id)];
        if (!visibleIds.includes(param.data.id)) {
          throw new ApiError(
            'You do not have permission to view this employee',
            403,
            true,
            '',
            { code: 'FORBIDDEN' },
          );
        }
      } else if (req.employee?.role === 'supervisor') {
        const mySubs = await getSupervisorSubordinates(req.employee.id);
        const visibleIds = [req.employee.id, ...mySubs.map((s) => s.id)];
        if (!visibleIds.includes(param.data.id)) {
          throw new ApiError(
            'You do not have permission to view this employee',
            403,
            true,
            '',
            { code: 'FORBIDDEN' },
          );
        }
      } else if (
        req.employee?.role === 'employee' &&
        param.data.id !== req.employee.id
      ) {
        throw new ApiError(
          'Employees may only view their own profile',
          403,
          true,
          '',
          { code: 'FORBIDDEN' },
        );
      }
    }

    const employeeResponse = await buildEmployeeResponse(
      row.employee,
      row.locationName,
      req.employee?.id === param.data.id ? 'self' : req.employee?.role,
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
        id: employees.id,
        email: employees.email,
        userId: employees.userId,
        status: employees.status,
        locationId: employees.locationId,
        role: employees.role,
      })
      .from(employees)
      .where(eq(employees.id, param.data.id))
      .limit(1);

    if (!existing) {
      throw new ApiError('Employee not found', 404, true, '', {
        code: 'EMPLOYEE_NOT_FOUND',
      });
    }

    // Role-based update authorization:
    // 1. super_admin: can update any employee and change role
    // 2. manager: can only update employees in their own location, cannot modify other managers, cannot change role
    // 3. supervisor/employee: forbidden
    if (!req.isSuperAdmin) {
      if (req.employee?.role === 'manager') {
        if (existing.locationId !== req.employee.locationId) {
          throw new ApiError(
            'You can only manage employees within your assigned location.',
            403,
            true,
            '',
            {
              code: 'FORBIDDEN',
            },
          );
        }
        if (existing.id === req.employee.id) {
          throw new ApiError(
            'Managers cannot edit their own employee profile from the staff roster.',
            403,
            true,
            '',
            {
              code: 'FORBIDDEN',
            },
          );
        }
        if (existing.role === 'manager') {
          throw new ApiError(
            'Managers cannot modify other managers.',
            403,
            true,
            '',
            {
              code: 'FORBIDDEN',
            },
          );
        }
        if (parsed.data.role && parsed.data.role !== existing.role) {
          throw new ApiError(
            'Managers cannot change employee roles.',
            403,
            true,
            '',
            {
              code: 'FORBIDDEN',
            },
          );
        }
      } else {
        throw new ApiError(
          'You do not have permission to update employees.',
          403,
          true,
          '',
          {
            code: 'FORBIDDEN',
          },
        );
      }
    }

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

    const employeeResponse = await buildEmployeeResponse(
      updated,
      undefined,
      req.isSuperAdmin ? 'super_admin' : req.employee?.role,
    );

    res.status(200).json(
      ApiResponse.success('Employee updated successfully', {
        employee: employeeResponse,
        ...(inviteUrl ? { inviteUrl } : {}),
      }),
    );
  },
);
