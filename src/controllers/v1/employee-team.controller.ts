import type { Request, Response } from 'express';
import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import catchAsync from '../../shared/utils/catchAsync.ts';
import { idParam } from '../../shared/validations/employees.schema.ts';
import { db } from '../../db/client.ts';
import { employees } from '../../db/index.ts';
import { eq, inArray } from 'drizzle-orm';
import {
  listSupervisors,
  listManagers,
  getManagerSubordinates,
  getSupervisorSubordinates,
  setSupervisorSubordinates,
  setManagerSupervisors,
} from '../../services/employee/employee.service.ts';

// ---------- GET /api/admin/employees/supervisors ---------------------------
export const getSupervisors = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const locationId =
      (req.query.locationId as string) || req.employee?.locationId;
    const supervisors = await listSupervisors(locationId);
    res.status(200).json(
      ApiResponse.success('Supervisors retrieved successfully', {
        supervisors,
      }),
    );
  },
);

// ---------- GET /api/admin/employees/managers ------------------------------
export const getManagers = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const locationId =
      (req.query.locationId as string) || req.employee?.locationId;
    const managers = await listManagers(locationId);
    res.status(200).json(
      ApiResponse.success('Managers retrieved successfully', {
        managers,
      }),
    );
  },
);

// ---------- GET /api/admin/employees/subordinates --------------------------
export const getSubordinates = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.employee?.id) {
      throw new ApiError('Employee profile required', 400, true, '', {
        code: 'EMPLOYEE_PROFILE_REQUIRED',
      });
    }
    const subordinates =
      req.employee.role === 'manager'
        ? await getManagerSubordinates(req.employee.id)
        : await getSupervisorSubordinates(req.employee.id);

    res.status(200).json(
      ApiResponse.success('Subordinates retrieved successfully', {
        subordinates,
      }),
    );
  },
);

// ---------- PUT /api/admin/employees/:id/subordinates ----------------------
// Assign employees to a supervisor, or assign supervisors to a manager.
export const updateSubordinates = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const param = idParam.safeParse(req.params);
    if (!param.success) {
      throw new ApiError('Invalid employee id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }
    const targetId = param.data.id;

    const [target] = await db
      .select({
        id: employees.id,
        role: employees.role,
        locationId: employees.locationId,
      })
      .from(employees)
      .where(eq(employees.id, targetId))
      .limit(1);

    if (!target) {
      throw new ApiError('Target employee not found', 404, true, '', {
        code: 'EMPLOYEE_NOT_FOUND',
      });
    }

    const { subordinateIds } = req.body;
    if (!Array.isArray(subordinateIds)) {
      throw new ApiError('subordinateIds array is required', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    // Role-based authorization & validation:
    // 1. If target is a SUPERVISOR:
    //    - Only Super Admin or a Manager of that location can assign subordinates.
    //    - Assigned subordinates must be employees in the same location.
    if (target.role === 'supervisor') {
      if (!req.isSuperAdmin) {
        if (
          req.employee?.role !== 'manager' ||
          req.employee?.locationId !== target.locationId
        ) {
          throw new ApiError(
            'Only managers of this location or super admins can assign employees to supervisors.',
            403,
            true,
            '',
            { code: 'FORBIDDEN' },
          );
        }
      }

      if (subordinateIds.length > 0) {
        const assignedEmps = await db
          .select({ id: employees.id, locationId: employees.locationId })
          .from(employees)
          .where(inArray(employees.id, subordinateIds));

        if (assignedEmps.length !== subordinateIds.length) {
          throw new ApiError(
            'One or more selected employees do not exist.',
            400,
            true,
            '',
            { code: 'EMPLOYEE_NOT_FOUND' },
          );
        }
        for (const emp of assignedEmps) {
          if (emp.locationId !== target.locationId) {
            throw new ApiError(
              'Cannot assign employees from a different location.',
              400,
              true,
              '',
              { code: 'CROSS_LOCATION_ASSIGNMENT_FORBIDDEN' },
            );
          }
        }
      }

      const updatedSubordinates = await setSupervisorSubordinates(
        targetId,
        subordinateIds,
      );
      res.status(200).json(
        ApiResponse.success('Supervisor team updated successfully', {
          subordinates: updatedSubordinates,
        }),
      );
      return;
    }

    // 2. If target is a MANAGER:
    //    - Only Super Admin can assign supervisors to a manager.
    //    - Assigned subordinates must be supervisors in the same location.
    if (target.role === 'manager') {
      if (!req.isSuperAdmin) {
        throw new ApiError(
          'Only super admins can assign supervisors to managers.',
          403,
          true,
          '',
          { code: 'FORBIDDEN' },
        );
      }

      if (subordinateIds.length > 0) {
        const assignedSups = await db
          .select({
            id: employees.id,
            locationId: employees.locationId,
            role: employees.role,
          })
          .from(employees)
          .where(inArray(employees.id, subordinateIds));

        if (assignedSups.length !== subordinateIds.length) {
          throw new ApiError(
            'One or more selected supervisors do not exist.',
            400,
            true,
            '',
            { code: 'SUPERVISOR_NOT_FOUND' },
          );
        }
        for (const sup of assignedSups) {
          if (sup.locationId !== target.locationId) {
            throw new ApiError(
              'Cannot assign supervisors from a different location.',
              400,
              true,
              '',
              { code: 'CROSS_LOCATION_ASSIGNMENT_FORBIDDEN' },
            );
          }
        }
      }

      const updatedSupervisors = await setManagerSupervisors(
        targetId,
        subordinateIds,
      );
      res.status(200).json(
        ApiResponse.success('Manager supervisors updated successfully', {
          subordinates: updatedSupervisors,
        }),
      );
      return;
    }

    throw new ApiError(
      'Subordinates can only be assigned to supervisors or managers.',
      400,
      true,
      '',
      { code: 'INVALID_ROLE' },
    );
  },
);

// ---------- GET /api/v1/employees/roles ------------------------------------
export const getOperationalRoles = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const availableRoles = req.isSuperAdmin
      ? [
          {
            id: 'manager',
            name: 'Manager',
            description: 'Department or location manager',
          },
          {
            id: 'supervisor',
            name: 'Supervisor',
            description: 'Team and shift supervisor',
          },
          {
            id: 'employee',
            name: 'Employee',
            description: 'Operational staff and training learner',
          },
        ]
      : [
          {
            id: 'supervisor',
            name: 'Supervisor',
            description: 'Team and shift supervisor',
          },
          {
            id: 'employee',
            name: 'Employee',
            description: 'Operational staff and training learner',
          },
        ];

    res.status(200).json(
      ApiResponse.success('Roles retrieved successfully', {
        roles: availableRoles,
      }),
    );
  },
);
