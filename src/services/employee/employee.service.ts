import { eq, inArray, and, ne, gt, desc, ilike } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  employees,
  user,
  verification,
  locations,
  stations,
  jobs,
  employeeSupervisors,
  supervisorManagers,
} from '../../db/index.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import type {
  LanguagePref,
  EmployeeRole,
  EmployeeStatus,
} from '../../db/index.ts';
import { auth, magicLinkUrls } from '../../config/auth.ts';
import config from '../../config/index.ts';
import { logger } from '../../config/logger.ts';
import crypto from 'node:crypto';
import { syncEmployeeCourses } from '../courses/course-assignments.service.ts';

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
      callbackURL: `${frontendUrl}/${input.languagePref}/set-password`,
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

export interface CreateEmployeeInput {
  name: string;
  email: string;
  locationId: string;
  role: string;
  jobIds?: string[] | undefined;
  stationIds?: string[] | undefined;
  employeeCode?: string | null | undefined;
  languagePref: LanguagePref;
  dateOfBirth?: string | null | undefined;
  fathersName?: string | null | undefined;
  gender?: string | null | undefined;
  address?: string | null | undefined;
  phoneNumber?: string | null | undefined;
  emergencyContactName?: string | null | undefined;
  emergencyContactRelation?: string | null | undefined;
  emergencyContactPhone?: string | null | undefined;
  startDate?: string | null | undefined;
  sinNumber?: string | null | undefined;
  hourlyRate?: string | number | null | undefined;
  supervisorIds?: string[] | undefined;
  managerIds?: string[] | undefined;
  subordinateIds?: string[] | undefined;
}

export async function createEmployeeTransaction(
  input: CreateEmployeeInput,
  adminId: string,
) {
  return db.transaction(async (tx) => {
    const [loc] = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.id, input.locationId))
      .limit(1);
    if (!loc)
      throw new ApiError('Location not found.', 400, true, '', {
        code: 'LOCATION_NOT_FOUND',
      });

    if (input.stationIds && input.stationIds.length > 0) {
      const st = await tx
        .select({ id: stations.id })
        .from(stations)
        .where(inArray(stations.id, input.stationIds));
      if (st.length !== input.stationIds.length)
        throw new ApiError(
          'One or more selected stations do not exist.',
          400,
          true,
          '',
          {
            code: 'STATION_NOT_FOUND',
          },
        );
    }

    if (input.jobIds && input.jobIds.length > 0) {
      const jb = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(inArray(jobs.id, input.jobIds));
      if (jb.length !== input.jobIds.length)
        throw new ApiError(
          'One or more selected job roles do not exist.',
          400,
          true,
          '',
          {
            code: 'JOB_NOT_FOUND',
          },
        );
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
      throw new ApiError(
        'That email is already in use by another employee.',
        409,
        true,
        '',
        {
          code: 'EMAIL_TAKEN',
        },
      );

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
      dateOfBirth: input.dateOfBirth ?? null,
      fathersName: input.fathersName ?? null,
      gender: input.gender ?? null,
      address: input.address ?? null,
      phoneNumber: input.phoneNumber ?? null,
      emergencyContactName: input.emergencyContactName ?? null,
      emergencyContactRelation: input.emergencyContactRelation ?? null,
      emergencyContactPhone: input.emergencyContactPhone ?? null,
      startDate: input.startDate ?? null,
      sinNumber: input.sinNumber ?? null,
      hourlyRate: input.hourlyRate != null ? String(input.hourlyRate) : null,
    });

    // Handle reporting hierarchy junction table insertions
    if (input.supervisorIds && input.supervisorIds.length > 0) {
      const sups = await tx
        .select({ id: employees.id, role: employees.role })
        .from(employees)
        .where(inArray(employees.id, input.supervisorIds));
      if (sups.length !== input.supervisorIds.length) {
        throw new ApiError(
          'One or more selected supervisors do not exist.',
          400,
          true,
          '',
          { code: 'SUPERVISOR_NOT_FOUND' },
        );
      }
      await tx.insert(employeeSupervisors).values(
        input.supervisorIds.map((supervisorId) => ({
          employeeId,
          supervisorId,
        })),
      );
    }

    if (input.managerIds && input.managerIds.length > 0) {
      const mgrs = await tx
        .select({ id: employees.id, role: employees.role })
        .from(employees)
        .where(inArray(employees.id, input.managerIds));
      if (mgrs.length !== input.managerIds.length) {
        throw new ApiError(
          'One or more selected managers do not exist.',
          400,
          true,
          '',
          { code: 'MANAGER_NOT_FOUND' },
        );
      }
      await tx.insert(supervisorManagers).values(
        input.managerIds.map((managerId) => ({
          supervisorId: employeeId,
          managerId,
        })),
      );
    }

    // Optional direct subordinates assignment at creation time
    if (input.subordinateIds && input.subordinateIds.length > 0) {
      if (input.role === 'supervisor') {
        // Subordinates are kitchen employees
        await tx.insert(employeeSupervisors).values(
          input.subordinateIds.map((empId) => ({
            employeeId: empId,
            supervisorId: employeeId,
          })),
        );
      } else if (input.role === 'manager') {
        // Subordinates are supervisors
        await tx.insert(supervisorManagers).values(
          input.subordinateIds.map((supId) => ({
            supervisorId: supId,
            managerId: employeeId,
          })),
        );
      }
    }

    // Auto-assign any courses that match the employee's location, jobs, or stations
    try {
      await syncEmployeeCourses(employeeId, tx);
    } catch (err) {
      logger.error({ err }, 'Failed to auto-assign courses to new employee');
    }

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

export interface UpdateEmployeeInput {
  name: string;
  email: string;
  locationId: string;
  role: string;
  employeeCode?: string | null | undefined;
  jobIds?: string[] | undefined;
  stationIds?: string[] | undefined;
  languagePref: LanguagePref;
  status?: EmployeeStatus | undefined;
  dateOfBirth?: string | null | undefined;
  fathersName?: string | null | undefined;
  gender?: string | null | undefined;
  address?: string | null | undefined;
  phoneNumber?: string | null | undefined;
  emergencyContactName?: string | null | undefined;
  emergencyContactRelation?: string | null | undefined;
  emergencyContactPhone?: string | null | undefined;
  startDate?: string | null | undefined;
  sinNumber?: string | null | undefined;
  hourlyRate?: string | number | null | undefined;
  supervisorIds?: string[] | undefined;
  managerIds?: string[] | undefined;
  subordinateIds?: string[] | undefined;
}

export async function updateEmployeeTransaction(
  id: string,
  input: UpdateEmployeeInput,
  adminId: string,
) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: employees.id,
        email: employees.email,
        userId: employees.userId,
        name: employees.name,
        role: employees.role,
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
      throw new ApiError('Location not found', 400, true, '', {
        code: 'LOCATION_NOT_FOUND',
      });

    if (input.stationIds && input.stationIds.length > 0) {
      const st = await tx
        .select({ id: stations.id })
        .from(stations)
        .where(inArray(stations.id, input.stationIds));
      if (st.length !== input.stationIds.length)
        throw new ApiError(
          'One or more selected stations do not exist',
          400,
          true,
          '',
          {
            code: 'STATION_NOT_FOUND',
          },
        );
    }

    if (input.jobIds && input.jobIds.length > 0) {
      const jb = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(inArray(jobs.id, input.jobIds));
      if (jb.length !== input.jobIds.length)
        throw new ApiError(
          'One or more selected job roles do not exist',
          400,
          true,
          '',
          {
            code: 'JOB_NOT_FOUND',
          },
        );
    }

    if (input.email !== existing.email) {
      const [emailHit] = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(and(eq(employees.email, input.email), ne(employees.id, id)))
        .limit(1);
      if (emailHit)
        throw new ApiError(
          'That email is already in use by another employee.',
          409,
          true,
          '',
          {
            code: 'EMAIL_TAKEN',
          },
        );

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
        ...(input.employeeCode !== undefined && {
          employeeCode: input.employeeCode,
        }),
        jobIds: input.jobIds ?? [],
        stationIds: input.stationIds ?? [],
        languagePref: input.languagePref,
        ...(input.status && { status: input.status }),
        ...(input.dateOfBirth !== undefined && {
          dateOfBirth: input.dateOfBirth,
        }),
        ...(input.fathersName !== undefined && {
          fathersName: input.fathersName,
        }),
        ...(input.gender !== undefined && { gender: input.gender }),
        ...(input.address !== undefined && { address: input.address }),
        ...(input.phoneNumber !== undefined && {
          phoneNumber: input.phoneNumber,
        }),
        ...(input.emergencyContactName !== undefined && {
          emergencyContactName: input.emergencyContactName,
        }),
        ...(input.emergencyContactRelation !== undefined && {
          emergencyContactRelation: input.emergencyContactRelation,
        }),
        ...(input.emergencyContactPhone !== undefined && {
          emergencyContactPhone: input.emergencyContactPhone,
        }),
        ...(input.startDate !== undefined && { startDate: input.startDate }),
        ...(input.sinNumber !== undefined && { sinNumber: input.sinNumber }),
        ...(input.hourlyRate !== undefined && {
          hourlyRate:
            input.hourlyRate != null ? String(input.hourlyRate) : null,
        }),
      })
      .where(eq(employees.id, id))
      .returning();

    // Update supervisor relationships if provided
    if (input.supervisorIds !== undefined) {
      await tx
        .delete(employeeSupervisors)
        .where(eq(employeeSupervisors.employeeId, id));

      if (input.supervisorIds.length > 0) {
        const sups = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(inArray(employees.id, input.supervisorIds));
        if (sups.length !== input.supervisorIds.length) {
          throw new ApiError(
            'One or more selected supervisors do not exist.',
            400,
            true,
            '',
            { code: 'SUPERVISOR_NOT_FOUND' },
          );
        }
        await tx.insert(employeeSupervisors).values(
          input.supervisorIds.map((supervisorId) => ({
            employeeId: id,
            supervisorId,
          })),
        );
      }
    }

    // Update manager relationships if provided
    if (input.managerIds !== undefined) {
      await tx
        .delete(supervisorManagers)
        .where(eq(supervisorManagers.supervisorId, id));

      if (input.managerIds.length > 0) {
        const mgrs = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(inArray(employees.id, input.managerIds));
        if (mgrs.length !== input.managerIds.length) {
          throw new ApiError(
            'One or more selected managers do not exist.',
            400,
            true,
            '',
            { code: 'MANAGER_NOT_FOUND' },
          );
        }
        await tx.insert(supervisorManagers).values(
          input.managerIds.map((managerId) => ({
            supervisorId: id,
            managerId,
          })),
        );
      }
    }

    void adminId;

    if (!updated)
      throw new ApiError('Error updating employee', 500, true, '', {
        code: 'INTERNAL_ERROR',
      });

    // Auto-assign any newly matching courses for updated location, jobs, or stations
    try {
      await syncEmployeeCourses(id, tx);
    } catch (err) {
      logger.error(
        { err },
        'Failed to auto-assign courses to updated employee',
      );
    }

    return { employee: updated };
  });
}

// ============================================================================
// Hierarchy Query Helpers
// ============================================================================

export async function getEmployeeSupervisors(employeeId: string) {
  const rows = await db
    .select({
      id: employees.id,
      name: employees.name,
      email: employees.email,
      role: employees.role,
    })
    .from(employeeSupervisors)
    .innerJoin(employees, eq(employees.id, employeeSupervisors.supervisorId))
    .where(eq(employeeSupervisors.employeeId, employeeId));
  return rows;
}

export async function getSupervisorManagers(supervisorId: string) {
  const rows = await db
    .select({
      id: employees.id,
      name: employees.name,
      email: employees.email,
      role: employees.role,
    })
    .from(supervisorManagers)
    .innerJoin(employees, eq(employees.id, supervisorManagers.managerId))
    .where(eq(supervisorManagers.supervisorId, supervisorId));
  return rows;
}

export async function getSupervisorSubordinates(supervisorId: string) {
  const rows = await db
    .select({
      id: employees.id,
      name: employees.name,
      email: employees.email,
      employeeCode: employees.employeeCode,
      locationId: employees.locationId,
      role: employees.role,
      status: employees.status,
    })
    .from(employeeSupervisors)
    .innerJoin(employees, eq(employees.id, employeeSupervisors.employeeId))
    .where(
      and(
        eq(employeeSupervisors.supervisorId, supervisorId),
        ne(employeeSupervisors.employeeId, supervisorId),
      ),
    );
  return rows.filter((r) => r.id !== supervisorId);
}

export async function getManagerSubordinates(managerId: string) {
  // 1. Direct supervisors assigned to this manager (never include managerId)
  const sups = await db
    .select({
      id: employees.id,
      name: employees.name,
      email: employees.email,
      employeeCode: employees.employeeCode,
      locationId: employees.locationId,
      role: employees.role,
      status: employees.status,
    })
    .from(supervisorManagers)
    .innerJoin(employees, eq(employees.id, supervisorManagers.supervisorId))
    .where(
      and(
        eq(supervisorManagers.managerId, managerId),
        ne(supervisorManagers.supervisorId, managerId),
      ),
    );

  const supervisorIds = sups.map((s) => s.id).filter((id) => id !== managerId);

  let emps: Array<{
    id: string;
    name: string;
    email: string;
    employeeCode: string | null;
    locationId: string;
    role: EmployeeRole;
    status: EmployeeStatus;
  }> = [];

  const targetSupervisorIds = Array.from(
    new Set([...supervisorIds, managerId]),
  );

  if (targetSupervisorIds.length > 0) {
    emps = await db
      .select({
        id: employees.id,
        name: employees.name,
        email: employees.email,
        employeeCode: employees.employeeCode,
        locationId: employees.locationId,
        role: employees.role,
        status: employees.status,
      })
      .from(employeeSupervisors)
      .innerJoin(employees, eq(employees.id, employeeSupervisors.employeeId))
      .where(
        and(
          inArray(employeeSupervisors.supervisorId, targetSupervisorIds),
          ne(employeeSupervisors.employeeId, managerId),
        ),
      );
  }

  const map = new Map<string, (typeof sups)[0]>();
  for (const s of sups) {
    if (s.id !== managerId) map.set(s.id, s);
  }
  for (const e of emps) {
    if (e.id !== managerId) map.set(e.id, e);
  }

  return Array.from(map.values()).filter((item) => item.id !== managerId);
}

export async function setSupervisorSubordinates(
  supervisorId: string,
  employeeIds: string[],
) {
  return db.transaction(async (tx) => {
    // 1. Remove existing employee-supervisor links for this supervisor
    await tx
      .delete(employeeSupervisors)
      .where(eq(employeeSupervisors.supervisorId, supervisorId));

    // 2. If new employees provided, insert them
    if (employeeIds.length > 0) {
      const uniqueEmployeeIds = Array.from(new Set(employeeIds)).filter(
        (id) => id !== supervisorId,
      );
      if (uniqueEmployeeIds.length > 0) {
        await tx.insert(employeeSupervisors).values(
          uniqueEmployeeIds.map((employeeId) => ({
            supervisorId,
            employeeId,
          })),
        );
      }
    }

    return getSupervisorSubordinates(supervisorId);
  });
}

export async function setManagerSupervisors(
  managerId: string,
  supervisorIds: string[],
) {
  return db.transaction(async (tx) => {
    // 1. Remove existing supervisor-manager links for this manager
    await tx
      .delete(supervisorManagers)
      .where(eq(supervisorManagers.managerId, managerId));

    // 2. If new supervisors provided, insert them
    if (supervisorIds.length > 0) {
      const uniqueSupervisorIds = Array.from(new Set(supervisorIds)).filter(
        (id) => id !== managerId,
      );
      if (uniqueSupervisorIds.length > 0) {
        await tx.insert(supervisorManagers).values(
          uniqueSupervisorIds.map((supervisorId) => ({
            managerId,
            supervisorId,
          })),
        );
      }
    }

    // Return the updated list of supervisors reporting to this manager
    const rows = await tx
      .select({
        id: employees.id,
        name: employees.name,
        email: employees.email,
        employeeCode: employees.employeeCode,
        locationId: employees.locationId,
        role: employees.role,
        status: employees.status,
      })
      .from(supervisorManagers)
      .innerJoin(employees, eq(employees.id, supervisorManagers.supervisorId))
      .where(eq(supervisorManagers.managerId, managerId));
    return rows;
  });
}

export async function listSupervisors(locationId?: string) {
  const conditions = [
    eq(employees.role, 'supervisor'),
    eq(employees.status, 'active'),
  ];
  if (locationId) {
    conditions.push(eq(employees.locationId, locationId));
  }
  return db
    .select({
      id: employees.id,
      name: employees.name,
      email: employees.email,
      locationId: employees.locationId,
    })
    .from(employees)
    .where(and(...conditions))
    .orderBy(employees.name);
}

export async function listManagers(locationId?: string) {
  const conditions = [
    eq(employees.role, 'manager'),
    eq(employees.status, 'active'),
  ];
  if (locationId) {
    conditions.push(eq(employees.locationId, locationId));
  }
  return db
    .select({
      id: employees.id,
      name: employees.name,
      email: employees.email,
      locationId: employees.locationId,
    })
    .from(employees)
    .where(and(...conditions))
    .orderBy(employees.name);
}
