import type { Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { employees } from '../db/schema/index.ts';
import type { Role } from '../db/schema/employees.schema.ts';
import type { AuthedRequest } from './require-auth.ts';
import type { AuthedEmployee } from '../types/express.ts';

export const requireRoles = (allowedRoles: Role[]) => {
  return async (
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (!req.session) {
      res.status(401).json({
        error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' },
      });
      return;
    }

    if (req.isSuperAdmin) {
      if (!allowedRoles.includes('super_admin')) {
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'You do not have permission to perform this action.',
          },
        });
        return;
      }

      return next();
    }

    const [row] = await db
      .select({
        id: employees.id,
        userId: employees.userId,
        name: employees.name,
        locationId: employees.locationId,
        role: employees.role,
        email: employees.email,
        languagePref: employees.languagePref,
        status: employees.status,
        stationIds: employees.stationIds,
      })
      .from(employees)
      .where(eq(employees.id, req.session.employeeId))
      .limit(1);

    if (!row) {
      res.status(401).json({
        error: { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found' },
      });
      return;
    }

    if (row.status !== 'active') {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Active status required',
        },
      });
      return;
    }

    if (!allowedRoles.includes(row.role)) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'You do not have permission to perform this action.',
        },
      });
      return;
    }

    const safe: AuthedEmployee = {
      id: row.id,
      userId: row.userId ?? '',
      name: row.name,
      locationId: row.locationId,
      role: row.role,
      email: row.email,
      languagePref: row.languagePref,
      status: row.status,
      stationIds: row.stationIds || [],
    };
    req.employee = safe;
    next();
  };
};
