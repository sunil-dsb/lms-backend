import type { Request, Response } from 'express';
import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import catchAsync from '../../shared/utils/catchAsync.ts';
import { idParam } from '../../shared/validations/employees.schema.ts';
import { db } from '../../db/client.ts';
import { employees, session } from '../../db/index.ts';
import { eq } from 'drizzle-orm';
import {
  sendInviteMagicLink,
  getActiveInviteUrl,
} from '../../services/employee/employee.service.ts';
import { buildEmployeeResponse } from './employee-helpers.ts';

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

    if (!updated) {
      throw new ApiError('Employee not found', 404, true, '', {
        code: 'EMPLOYEE_NOT_FOUND',
      });
    }

    const employeeResponse = await buildEmployeeResponse(
      updated,
      undefined,
      req.isSuperAdmin ? 'super_admin' : req.employee?.role,
    );

    res.status(200).json(
      ApiResponse.success('Employee deactivated successfully', {
        employee: employeeResponse,
      }),
    );
  },
);

// ---------- POST /api/admin/employees/:id/reactivate -----------------------
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
          message: 'Only deactivated employees can be reactivated.',
        },
      });
      return;
    }

    const nextStatus = employee.userId ? 'active' : 'pending';

    await db
      .update(employees)
      .set({ status: nextStatus, deactivatedAt: null })
      .where(eq(employees.id, employee.id));

    let inviteUrl: string | undefined = undefined;
    if (nextStatus === 'pending') {
      inviteUrl = await getActiveInviteUrl(
        employee.email,
        employee.languagePref,
      );
      if (!inviteUrl) {
        inviteUrl = await sendInviteMagicLink({
          email: employee.email,
          name: employee.name,
          languagePref: employee.languagePref,
        });
      }
    }

    const [updated] = await db
      .select()
      .from(employees)
      .where(eq(employees.id, employee.id))
      .limit(1);

    if (!updated) {
      throw new ApiError('Employee not found', 404, true, '', {
        code: 'EMPLOYEE_NOT_FOUND',
      });
    }

    const employeeResponse = await buildEmployeeResponse(
      updated,
      undefined,
      req.isSuperAdmin ? 'super_admin' : req.employee?.role,
    );

    res.status(200).json(
      ApiResponse.success('Employee reactivated successfully', {
        employee: employeeResponse,
        ...(inviteUrl ? { inviteUrl } : {}),
      }),
    );
  },
);
