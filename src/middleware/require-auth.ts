import type { Request, Response, NextFunction } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { employees, user, SUPER_ADMIN_USER_ROLE } from '../db/schema/index.ts';

import { auth } from '../config/auth.ts';

export interface AuthedRequest extends Request {
  session?: {
    id: string;
    employeeId: string;
  };
  deviceMode?: 'personal' | 'shared';
}

export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const sessionResponse = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  const userId = sessionResponse?.user.id;
  const sessionId = sessionResponse?.session.id;

  if (!userId || !sessionId) {
    res.status(401).json({
      error: { code: 'SESSION_INVALID', message: 'Session expired or invalid' },
    });
    return;
  }

  // One query for both the user's role and their employee row (if any).
  const [row] = await db
    .select({
      userRole: user.role,
      employee: {
        id: employees.id,
        status: employees.status,
        locationId: employees.locationId,
        role: employees.role,
        stationIds: employees.stationIds,
      },
    })
    .from(user)
    .leftJoin(employees, eq(employees.userId, user.id))
    .where(eq(user.id, userId))
    .limit(1);

  if (!row) {
    res.status(401).json({
      error: { code: 'SESSION_INVALID', message: 'Session expired or invalid' },
    });
    return;
  }
  const { employee } = row;

  if (!employee) {
    // No employee row. Only users explicitly marked as super admin may pass;
    // anyone else (e.g. a self sign-up account) has no access at all.
    if (row.userRole !== SUPER_ADMIN_USER_ROLE) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'You do not have permission to perform this action.',
        },
      });
      return;
    }
    // Write operations that need a real employee UUID will be blocked (see
    // req.employee.id below).
    req.session = {
      id: sessionId,
      employeeId: 'super-admin',
    };
    req.isSuperAdmin = true;
    // IMPORTANT: do NOT use userId here — it is a better-auth nanoid (text),
    // not a uuid. Using it as req.employee.id would corrupt any uuid FK column
    // (e.g. procedures.created_by). Set id to empty string so callers that
    // attempt to write it to the DB get a clear validation error rather than a
    // cryptic postgres "invalid input syntax for type uuid" 500.
    req.employee = {
      id: '',
      userId: userId,
      locationId: 'global',
      role: 'super_admin',
      stationIds: [],
    };
    req.deviceMode =
      req.headers['x-device-mode'] === 'shared' ? 'shared' : 'personal';
    return next();
  }

  if (employee.status === 'deactivated') {
    res.status(403).json({
      error: {
        code: 'EMPLOYEE_DEACTIVATED',
        message: 'This account has been deactivated.',
      },
    });
    return;
  }

  if (employee.status !== 'active') {
    res.status(403).json({
      error: {
        code: 'ACCOUNT_NOT_ACTIVE',
        message: 'This account is not active.',
      },
    });
    return;
  }

  req.session = {
    id: sessionId,
    employeeId: employee.id,
  };
  req.employee = {
    id: employee.id,
    userId: userId,
    locationId: employee.locationId,
    role: employee.role,
    stationIds: employee.stationIds || [],
  };
  req.deviceMode =
    req.headers['x-device-mode'] === 'shared' ? 'shared' : 'personal';

  next();
}
