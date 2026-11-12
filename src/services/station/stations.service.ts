import crypto from 'node:crypto';
import { eq, count, ilike } from 'drizzle-orm';
import {
  formatPaginatedResult,
  type PaginatedResult,
} from '../../shared/utils/pagination.ts';
import { db } from '../../db/client.ts';
import { stations } from '../../db/index.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import {
  recordAudit,
  diffChanges,
  type AuditActor,
} from '../audit/audit.service.ts';

export interface PublicStation {
  id: string;
  name: string;
}

export function publicStation(
  s: Readonly<typeof stations.$inferSelect>,
): PublicStation {
  return {
    id: s.id,
    name: s.name,
  };
}

export interface StationCreateInput {
  name: string;
}

export interface StationPatchInput {
  name?: string | undefined;
}

export async function listStations(
  page: number = 1,
  limit: number = 10,
  search?: string,
): Promise<PaginatedResult<PublicStation>> {
  const offset = (page - 1) * limit;
  const whereClause = search ? ilike(stations.name, `%${search}%`) : undefined;
  const rows = await db
    .select()
    .from(stations)
    .where(whereClause)
    .limit(limit)
    .offset(offset);
  const [countRes] = await db
    .select({ total: count() })
    .from(stations)
    .where(whereClause);
  return formatPaginatedResult(
    rows.map(publicStation),
    countRes?.total ?? 0,
    page,
    limit,
  );
}

export async function createStation(
  input: StationCreateInput,
  actor: AuditActor,
): Promise<PublicStation> {
  const id = crypto.randomUUID();
  await db.insert(stations).values({
    id,
    name: input.name,
  });
  const [row] = await db
    .select()
    .from(stations)
    .where(eq(stations.id, id))
    .limit(1);
  if (!row) {
    throw Object.assign(new ApiError('Inserted station not found', 500), {
      errorCode: 'INTERNAL_ERROR',
    });
  }

  await recordAudit({
    actor,
    itemType: 'station',
    itemId: id,
    itemName: row.name,
    action: 'create',
    changes: { name: { from: null, to: row.name } },
  });

  return publicStation(row);
}

export async function updateStation(
  id: string,
  patch: StationPatchInput,
  actor: AuditActor,
): Promise<PublicStation> {
  if (Object.keys(patch).length === 0) {
    throw Object.assign(
      new ApiError('Patch must include at least one field', 400),
      { errorCode: 'INVALID_INPUT' },
    );
  }
  const [existing] = await db
    .select()
    .from(stations)
    .where(eq(stations.id, id))
    .limit(1);
  if (!existing) {
    throw Object.assign(new ApiError('Station not found', 404), {
      errorCode: 'STATION_NOT_FOUND',
    });
  }
  await db.update(stations).set(patch).where(eq(stations.id, id));
  const [updated] = await db
    .select()
    .from(stations)
    .where(eq(stations.id, id))
    .limit(1);
  if (!updated) {
    throw Object.assign(new ApiError('Updated station not found', 500), {
      errorCode: 'INTERNAL_ERROR',
    });
  }

  const changes = diffChanges(
    existing as unknown as Record<string, unknown>,
    updated as unknown as Record<string, unknown>,
    ['name'],
  );
  if (changes) {
    await recordAudit({
      actor,
      itemType: 'station',
      itemId: id,
      itemName: updated.name,
      action: 'update',
      changes,
    });
  }

  return publicStation(updated);
}

export async function deleteStation(
  id: string,
  actor: AuditActor,
): Promise<void> {
  const [existing] = await db
    .select({ id: stations.id, name: stations.name })
    .from(stations)
    .where(eq(stations.id, id))
    .limit(1);
  if (!existing) {
    throw Object.assign(new ApiError('Station not found', 404), {
      errorCode: 'STATION_NOT_FOUND',
    });
  }
  await db.delete(stations).where(eq(stations.id, id));

  await recordAudit({
    actor,
    itemType: 'station',
    itemId: id,
    itemName: existing.name,
    action: 'delete',
    changes: { name: { from: existing.name, to: null } },
  });
}
