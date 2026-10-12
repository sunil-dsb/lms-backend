import ApiError from '../../shared/utils/ApiError.ts';

import { employees } from '../../db/index.ts';
import { auth } from '../../config/auth.ts';
import type { Request } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { db } from '../../db/client.ts';
import { user, session, stations, jobs } from '../../db/index.ts';
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
// Delegates to Better Auth's emailOtp plugin:
//   auth.api.requestPasswordResetEmailOTP({ body: { email } })
// Better Auth handles OTP generation, storage in the verification table,
// and triggers sendVerificationOTP (defined in auth.ts) to send the email.
// ============================================================================

export async function forgotPasswordService(email: string): Promise<void> {
  await auth.api.requestPasswordResetEmailOTP({
    body: { email },
  });
}

// ============================================================================
// resetPasswordWithOtpService
// Delegates to Better Auth's emailOTP plugin:
//   auth.api.resetPasswordEmailOTP({ body: { email, otp, newPassword } })
// Better Auth verifies the OTP against the verification table, hashes the
// new password, and updates the credentials account row — all internally.
// Throws if the OTP is invalid or expired.
// ============================================================================

export async function resetPasswordWithOtpService(
  email: string,
  otp: string,
  newPassword: string,
): Promise<void> {
  const response = await auth.api.resetPasswordEmailOTP({
    body: { email, otp, password: newPassword },
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
}
