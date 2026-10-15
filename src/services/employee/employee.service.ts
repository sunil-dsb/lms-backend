import { eq, inArray, and, ne, gt, desc, ilike } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { employees, user, verification } from '../../db/index.ts';
import { locations, stations, jobs } from '../../db/index.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import type {
  LanguagePref,
  EmployeeRole,
  EmployeeStatus,
} from '../../db/index.ts';
import { auth, magicLinkUrls } from '../../config/auth.ts';
import config from '../../config/index.ts';
import crypto from 'node:crypto';

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').normalize('NFC');
}

// Removed uniqueEmployeeName as per user request

// ============================================================================
// Magic link invite
// ============================================================================

/**
 * Sends a Better Auth magic link to the employee email.
 * Returns the invite URL so the caller can also share it manually.
 *
 * Better Auth generates and hashes the token internally, storing it
 * in the verification table. No custom crypto needed here.
 */
export async function sendInviteMagicLink(input: {
  email: string;
  languagePref: LanguagePref;
  name?: string;
}): Promise<string> {
  const frontendUrl = config.frontendBaseUrl.replace(/\/+$/, '');
  await auth.api.signInMagicLink({
    body: {
      email: input.email,
      name: input.name,
      newUserCallbackURL: `${frontendUrl}/${input.languagePref}/set-password`,
      callbackURL: `${frontendUrl}/${input.languagePref}/dashboard`,
    },
    headers: new Headers({ 'Content-Type': 'application/json' }),
  });

  const uglyUrl = magicLinkUrls.get(input.email) || '';
  magicLinkUrls.delete(input.email);

  if (!uglyUrl) return '';

  const parsed = new URL(uglyUrl);
  const token = parsed.searchParams.get('token');

  return `${frontendUrl}/${input.languagePref}/invite/token?token=${token}`;
}

/**
 * Looks up the latest active (non-expired) invite magic link URL for a pending employee.
 */
export async function getActiveInviteUrl(
  email: string,
  languagePref: LanguagePref,
): Promise<string | undefined> {
  const [ver] = await db
    .select({ identifier: verification.identifier })
    .from(verification)
    .where(
      and(
        ilike(verification.value, `%"email":"${email}"%`),
        gt(verification.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(verification.createdAt))
    .limit(1);

  if (!ver) return undefined;
  const baseUrl = config.frontendBaseUrl.replace(/\/+$/, '');
  return `${baseUrl}/${languagePref}/invite/token?token=${ver.identifier}`;
}

// ============================================================================
// Employee creation transaction
// ============================================================================

export async function createEmployeeTransaction(
  input: {
    name: string;
    email: string;
    locationId: string;
    role: string;
    jobIds?: string[];
    stationIds?: string[];
    employeeCode?: string | null | undefined;
    languagePref: LanguagePref;
  },
  adminId: string,
) {
  return db.transaction(async (tx) => {
    const [loc] = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.id, input.locationId))
      .limit(1);
    if (!loc)
      throw new ApiError('Unknown location', 400, true, '', {
        code: 'LOCATION_NOT_FOUND',
      });

    if (input.stationIds && input.stationIds.length > 0) {
      const st = await tx
        .select({ id: stations.id })
        .from(stations)
        .where(inArray(stations.id, input.stationIds));
      if (st.length !== input.stationIds.length)
        throw new ApiError('One or more unknown stations', 400, true, '', {
          code: 'STATION_NOT_FOUND',
        });
    }

    if (input.jobIds && input.jobIds.length > 0) {
      const jb = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(inArray(jobs.id, input.jobIds));
      if (jb.length !== input.jobIds.length)
        throw new ApiError('One or more unknown jobs', 400, true, '', {
          code: 'JOB_NOT_FOUND',
        });
    }

    if (input.employeeCode) {
      const [codeHit] = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(eq(employees.employeeCode, input.employeeCode))
        .limit(1);
      if (codeHit)
        throw new ApiError(
          'That employee code is already in use.',
          409,
          true,
          '',
          {
            code: 'EMPLOYEE_CODE_TAKEN',
          },
        );
    }

    const [emailHit] = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.email, input.email))
      .limit(1);
    if (emailHit)
      throw new ApiError('That email is already in use.', 409, true, '', {
        code: 'EMAIL_TAKEN',
      });

    const employeeName = normalizeName(input.name);
    const employeeId = crypto.randomUUID();
    await tx.insert(employees).values({
      id: employeeId,
      name: employeeName,
      employeeCode: input.employeeCode ?? null,
      email: input.email,
      locationId: input.locationId,
      role: (input.role as EmployeeRole) ?? 'employee',
      jobIds: input.jobIds ?? [],
      stationIds: input.stationIds ?? [],
      languagePref: input.languagePref,
      status: 'pending',
    });

    void adminId;

    const [row] = await tx
      .select()
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    if (!row)
      throw new ApiError('Inserted employee not found', 500, true, '', {
        code: 'INTERNAL_ERROR',
      });

    return { employee: row };
  });
}

// ============================================================================
// Employee update transaction
// ============================================================================

export async function updateEmployeeTransaction(
  id: string,
  input: {
    name: string;
    email: string;
    locationId: string;
    role: string;
    jobIds?: string[];
    stationIds?: string[];
    languagePref: LanguagePref;
    status?: EmployeeStatus;
  },
  adminId: string,
) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: employees.id,
        email: employees.email,
        userId: employees.userId,
        name: employees.name,
      })
      .from(employees)
      .where(eq(employees.id, id))
      .limit(1);

    if (!existing) {
      throw new ApiError('Employee not found', 404, true, '', {
        code: 'EMPLOYEE_NOT_FOUND',
      });
    }

    const [loc] = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.id, input.locationId))
      .limit(1);
    if (!loc)
      throw new ApiError('Unknown location', 400, true, '', {
        code: 'LOCATION_NOT_FOUND',
      });

    if (input.stationIds && input.stationIds.length > 0) {
      const st = await tx
        .select({ id: stations.id })
        .from(stations)
        .where(inArray(stations.id, input.stationIds));
      if (st.length !== input.stationIds.length)
        throw new ApiError('One or more unknown stations', 400, true, '', {
          code: 'STATION_NOT_FOUND',
        });
    }

    if (input.jobIds && input.jobIds.length > 0) {
      const jb = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(inArray(jobs.id, input.jobIds));
      if (jb.length !== input.jobIds.length)
        throw new ApiError('One or more unknown jobs', 400, true, '', {
          code: 'JOB_NOT_FOUND',
        });
    }

    if (input.email !== existing.email) {
      const [emailHit] = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(and(eq(employees.email, input.email), ne(employees.id, id)))
        .limit(1);
      if (emailHit)
        throw new ApiError('That email is already in use.', 409, true, '', {
          code: 'EMAIL_TAKEN',
        });

      // Also ensure the new email is not already taken by another Better Auth user
      const [userHit] = await tx
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, input.email))
        .limit(1);
      if (userHit && userHit.id !== existing.userId) {
        throw new ApiError(
          'That email is already in use by another account.',
          409,
          true,
          '',
          { code: 'EMAIL_TAKEN' },
        );
      }

      // Sync the new email to Better Auth's user table
      if (existing.userId) {
        await tx
          .update(user)
          .set({ email: input.email })
          .where(eq(user.id, existing.userId));
      } else {
        // If not linked yet, update any user row that was created with the old email
        await tx
          .update(user)
          .set({ email: input.email })
          .where(eq(user.email, existing.email));
      }
    }

    const employeeName = normalizeName(input.name);

    // Sync updated name to user table if linked
    if (existing.userId && employeeName !== existing.name) {
      await tx
        .update(user)
        .set({ name: employeeName })
        .where(eq(user.id, existing.userId));
    }

    const [updated] = await tx
      .update(employees)
      .set({
        name: employeeName,
        email: input.email,
        locationId: input.locationId,
        role: (input.role as EmployeeRole) ?? 'employee',
        jobIds: input.jobIds ?? [],
        stationIds: input.stationIds ?? [],
        languagePref: input.languagePref,
        ...(input.status && { status: input.status }),
      })
      .where(eq(employees.id, id))
      .returning();

    void adminId;

    if (!updated)
      throw new ApiError('Error updating employee', 500, true, '', {
        code: 'INTERNAL_ERROR',
      });

    return { employee: updated };
  });
}
