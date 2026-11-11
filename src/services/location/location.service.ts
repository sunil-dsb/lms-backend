import crypto from 'node:crypto';
import { eq, sql, count, ilike } from 'drizzle-orm';
import {
  formatPaginatedResult,
  type PaginatedResult,
} from '../../shared/utils/pagination.ts';
import { db } from '../../db/client.ts';
import { employees, locations } from '../../db/index.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import {
  recordAudit,
  diffChanges,
  type AuditActor,
} from '../audit/audit.service.ts';

export interface PublicLocation {
  id: string;
  name: string;
}

export function publicLocation(
  l: Readonly<typeof locations.$inferSelect>,
): PublicLocation {
  return {
    id: l.id,
    name: l.name,
  };
}

export interface LocationCreateInput {
  name: string;
}

export interface LocationPatchInput {
  name: string;
}

export async function listLocations(
  page: number = 1,
  limit: number = 10,
  search?: string,
): Promise<PaginatedResult<PublicLocation>> {
  const offset = (page - 1) * limit;
  const whereClause = search ? ilike(locations.name, `%${search}%`) : undefined;
  const rows = await db
    .select()
    .from(locations)
    .where(whereClause)
    .limit(limit)
    .offset(offset);
  const [countRes] = await db
    .select({ total: count() })
    .from(locations)
    .where(whereClause);
  return formatPaginatedResult(
    rows.map(publicLocation),
    countRes?.total ?? 0,
    page,
    limit,
  );
}

export async function createLocation(
  input: LocationCreateInput,
  actor: AuditActor,
): Promise<PublicLocation> {
  // Locations don't have a separate "id" UI field — backend generates a UUID
  // so the admin only has to type the display name. Existing seeded rows
  // keep their slug ids for backward compatibility with employees.location_id FKs.
  const id = crypto.randomUUID();
  await db.insert(locations).values({ id, name: input.name });
  const [row] = await db
    .select()
    .from(locations)
    .where(eq(locations.id, id))
    .limit(1);
  if (!row) {
    throw Object.assign(new ApiError('Inserted location not found', 500), {
      errorCode: 'INTERNAL_ERROR',
    });
  }

  await recordAudit({
    actor,
    itemType: 'location',
    itemId: id,
    itemName: row.name,
    action: 'create',
    changes: { name: { from: null, to: row.name } },
  });

  return publicLocation(row);
}

export async function updateLocation(
  id: string,
  patch: LocationPatchInput,
  actor: AuditActor,
): Promise<PublicLocation> {
  const [existing] = await db
    .select()
    .from(locations)
    .where(eq(locations.id, id))
    .limit(1);
  if (!existing) {
    throw Object.assign(new ApiError('Location not found', 404), {
      errorCode: 'LOCATION_NOT_FOUND',
    });
  }
  await db.update(locations).set(patch).where(eq(locations.id, id));
  const [updated] = await db
    .select()
    .from(locations)
    .where(eq(locations.id, id))
    .limit(1);
  if (!updated) {
    throw Object.assign(new ApiError('Updated location not found', 500), {
      errorCode: 'INTERNAL_ERROR',
    });
  }

  await recordAudit({
    actor,
    itemType: 'location',
    itemId: id,
    itemName: updated.name,
    action: 'update',
    changes: diffChanges(
      existing as unknown as Record<string, unknown>,
      updated as unknown as Record<string, unknown>,
      ['name'],
    ),
  });

  return publicLocation(updated);
}

// Hard delete — refused when any employee still references the location.
// employees.location_id has ON DELETE restrict.
export async function deleteLocation(
  id: string,
  actor: AuditActor,
): Promise<void> {
  const [existing] = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(eq(locations.id, id))
    .limit(1);
  if (!existing) {
    throw Object.assign(new ApiError('Location not found', 404), {
      errorCode: 'LOCATION_NOT_FOUND',
    });
  }
  const refs = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(employees)
    .where(eq(employees.locationId, id));
  const refCount = refs[0]?.c ?? 0;
  if (refCount > 0) {
    throw Object.assign(
      new ApiError(
        `Cannot delete: ${refCount} employee(s) still reference this location.`,
        409,
      ),
      { errorCode: 'LOCATION_IN_USE' },
    );
  }
  await db.delete(locations).where(eq(locations.id, id));

  await recordAudit({
    actor,
    itemType: 'location',
    itemId: id,
    itemName: existing.name,
    action: 'delete',
    changes: { name: { from: existing.name, to: null } },
  });
}
