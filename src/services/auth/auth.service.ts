import ApiError from '../../shared/utils/ApiError.ts';

import { auth } from '../../config/auth.ts';
import type { Request } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { db } from '../../db/client.ts';
import {
  user,
  session,
  stations,
  jobs,
  employees,
  SUPER_ADMIN_USER_ROLE,
} from '../../db/index.ts';
import { eq, inArray } from 'drizzle-orm';

type Employee = typeof employees.$inferSelect;

// ============================================================================
// publicEmployeeShape helper
// ============================================================================

export interface PublicEmployeeShape {
  id: string;
  name: string;
  locationId: string;
  role: string;
  jobIds: string[] | null;
  stationIds: string[] | null;
  email: string;
  languagePref: Employee['languagePref'];
}

export function publicEmployeeShape(e: Employee): PublicEmployeeShape {
  return {
    id: e.id,
    name: e.name,
    locationId: e.locationId,
    role: e.role,
    jobIds: e.jobIds,
    stationIds: e.stationIds,
    email: e.email,
    languagePref: e.languagePref,
  };
}

export interface LoginServiceInput {
  email: string;
  password: string;
}

export interface LoginServiceResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: any;
  // Raw session token — client stores and sends as: Authorization: Bearer <token>
  token: string;
  setCookies?: string[];
}

export async function loginUser(
  input: LoginServiceInput,
): Promise<LoginServiceResult> {
  const signInResponse = await auth.api.signInEmail({
    body: { email: input.email, password: input.password },
    asResponse: true,
  });

  if (!signInResponse.ok) {
    const error = await signInResponse.json().catch(() => ({}));
    throw new ApiError(
      error.message || 'Invalid email or password',
      signInResponse.status || 401,
      true,
      '',
      { code: 'INVALID_CREDENTIALS' },
    );
  }

  // better-auth returns { token, user } where token is the raw opaque
  // session token the client can send as: Authorization: Bearer <token>
  const data = await signInResponse.json();
  const token: string | undefined = data?.token;

  if (!token) {
    throw new ApiError('Sign-in failed; please try again.', 401, true, '', {
      code: 'SIGN_IN_FAILED',
    });
  }

  // Check linked employee to enrich user.name and block deactivated accounts
  const [emp] = await db
    .select({ name: employees.name, status: employees.status })
    .from(employees)
    .where(eq(employees.userId, data.user.id))
    .limit(1);

  if (emp) {
    if (emp.status === 'deactivated') {
      await db.delete(session).where(eq(session.userId, data.user.id));
      throw new ApiError('This account has been deactivated.', 403, true, '', {
        code: 'EMPLOYEE_DEACTIVATED',
      });
    }

    if (!data.user.name && emp.name) {
      data.user.name = emp.name;
      await db
        .update(user)
        .set({ name: emp.name })
        .where(eq(user.id, data.user.id));
    }
  }

  return {
    user: data.user,
    token,
    setCookies: signInResponse.headers.getSetCookie(),
  };
}

// ============================================================================
// getSessionService
// Reads headers from the request, gets the session from Better Auth, and
// retrieves the associated user and employee records.
// ============================================================================

export async function getSessionService(req: Request) {
  const sessionResponse = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  const userId = sessionResponse?.user.id;

  if (!userId) {
    throw new ApiError('Session expired or invalid', 401, true, '', {
      code: 'SESSION_INVALID',
    });
  }

  // Load the linked user row.
  const [userRow] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!userRow) {
    throw new ApiError('Session expired or invalid', 401, true, '', {
      code: 'SESSION_INVALID',
    });
  }

  // Look up the employee record (not present for super admins).
  const [employee] = await db
    .select()
    .from(employees)
    .where(eq(employees.userId, userId))
    .limit(1);

  // Super admins have no employee row — return user-level info.
  if (!employee) {
    return {
      user: { id: userRow.id, name: userRow.name, email: userRow.email },
      role: 'super_admin',
    };
  }

  if (employee.status === 'deactivated') {
    throw new ApiError('This account has been deactivated.', 403, true, '', {
      code: 'EMPLOYEE_DEACTIVATED',
    });
  }

  if (employee.status !== 'active') {
    throw new ApiError('This account is not active.', 403, true, '', {
      code: 'ACCOUNT_NOT_ACTIVE',
    });
  }

  const deviceMode: 'personal' | 'shared' =
    req.headers['x-device-mode'] === 'shared' ? 'shared' : 'personal';

  let stationDetails: { id: string; name: string }[] = [];
  if (employee.stationIds && employee.stationIds.length > 0) {
    stationDetails = await db
      .select({ id: stations.id, name: stations.name })
      .from(stations)
      .where(inArray(stations.id, employee.stationIds));
  }

  let jobDetails: { id: string; name: string }[] = [];
  if (employee.jobIds && employee.jobIds.length > 0) {
    jobDetails = await db
      .select({ id: jobs.id, name: jobs.name })
      .from(jobs)
      .where(inArray(jobs.id, employee.jobIds));
  }

  const {
    jobIds: _jobIds,
    stationIds: _stationIds,
    ...cleanEmployee
  } = publicEmployeeShape(employee);

  return {
    employee: {
      ...cleanEmployee,
      stations: stationDetails,
      jobs: jobDetails,
    },
    deviceMode,
  };
}

// ============================================================================
// forgotPasswordService
// Checks if the user/employee exists in our database and has an active account.
// If valid, delegates to Better Auth's emailOtp plugin to generate and send OTP.
// If the user doesn't exist or is not active, returns silently to prevent enumeration.
// ============================================================================

export async function forgotPasswordService(email: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();

  // 1. Check if an employee or user exists with this email
  const [emp] = await db
    .select({ id: employees.id, status: employees.status })
    .from(employees)
    .where(eq(employees.email, normalizedEmail))
    .limit(1);

  const [userRow] = await db
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(eq(user.email, normalizedEmail))
    .limit(1);

  // If user does not exist in our database at all, return early (silent to prevent user enumeration)
  if (!emp && !userRow) {
    return;
  }

  // If employee record exists, only allow active accounts (reject deactivated or pending)
  if (emp) {
    if (emp.status !== 'active') {
      return;
    }
  } else if (userRow && userRow.role !== SUPER_ADMIN_USER_ROLE) {
    // Non-employee accounts must be super_admin to have access
    return;
  }

  await auth.api.requestPasswordResetEmailOTP({
    body: { email: normalizedEmail },
  });
}

// ============================================================================
// resetPasswordWithOtpService
// Validates that the account is in the DB and active before resetting password.
// Delegates to Better Auth's emailOTP plugin:
//   auth.api.resetPasswordEmailOTP({ body: { email, otp, newPassword } })
// Better Auth verifies the OTP against the verification table, hashes the
// new password, and updates the credentials account row — all internally.
// Throws if the account is deactivated or if the OTP is invalid or expired.
// Revokes old active sessions upon successful reset.
// ============================================================================

export async function resetPasswordWithOtpService(
  email: string,
  otp: string,
  newPassword: string,
): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();

  // 1. Verify user exists in our DB and account is active
  const [emp] = await db
    .select({
      id: employees.id,
      status: employees.status,
      userId: employees.userId,
      requirePasswordChange: employees.requirePasswordChange,
    })
    .from(employees)
    .where(eq(employees.email, normalizedEmail))
    .limit(1);

  const [userRow] = await db
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(eq(user.email, normalizedEmail))
    .limit(1);

  if (!emp && !userRow) {
    throw new ApiError('User not found.', 404, true, '', {
      code: 'USER_NOT_FOUND',
    });
  }

  if (emp) {
    if (emp.status === 'deactivated') {
      throw new ApiError('This account has been deactivated.', 403, true, '', {
        code: 'EMPLOYEE_DEACTIVATED',
      });
    }

    if (emp.status !== 'active') {
      throw new ApiError('This account is not active.', 403, true, '', {
        code: 'ACCOUNT_NOT_ACTIVE',
      });
    }
  } else if (userRow && userRow.role !== SUPER_ADMIN_USER_ROLE) {
    throw new ApiError('This account is not active.', 403, true, '', {
      code: 'ACCOUNT_NOT_ACTIVE',
    });
  }

  // 2. Delegate OTP verification and password update to Better Auth
  const response = await auth.api.resetPasswordEmailOTP({
    body: { email: normalizedEmail, otp, password: newPassword },
    asResponse: true,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(
      error.message || 'Invalid or expired reset code.',
      response.status || 400,
      true,
      '',
      { code: error.code || 'INVALID_OTP' },
    );
  }

  // 3. Clear requirePasswordChange if it was set
  if (emp && emp.requirePasswordChange) {
    await db
      .update(employees)
      .set({ requirePasswordChange: false })
      .where(eq(employees.id, emp.id));
  }

  // 4. Invalidate any existing sessions so old sessions cannot be reused
  const targetUserId = userRow?.id || emp?.userId;
  if (targetUserId) {
    await db.delete(session).where(eq(session.userId, targetUserId));
  }
}
