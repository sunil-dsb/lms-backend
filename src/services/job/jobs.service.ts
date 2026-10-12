import crypto from 'node:crypto';
import { eq, inArray, sql, count, ilike, desc } from 'drizzle-orm';
import {
  formatPaginatedResult,
  type PaginatedResult,
} from '../../shared/utils/pagination.ts';
import { db } from '../../db/client.ts';
import { jobs, stations, employees } from '../../db/index.ts';
import ApiError from '../../shared/utils/ApiError.ts';

export interface PublicJob {
  id: string;
  name: string;
}

export function publicJob(r: Readonly<typeof jobs.$inferSelect>): PublicJob {
  return {
    id: r.id,
    name: r.name,
  };
}

export interface JobCreateInput {
  name: string;
  stationIds?: string[];
}

export interface JobPatchInput {
  name?: string | undefined;
  stationIds?: string[] | undefined;
}

export async function listJobs(
  page: number = 1,
  limit: number = 10,
  search?: string,
): Promise<PaginatedResult<PublicJob>> {
  const offset = (page - 1) * limit;
  const whereClause = search ? ilike(jobs.name, `%${search}%`) : undefined;
  const rows = await db
    .select({
      id: jobs.id,
      name: jobs.name,
      createdAt: jobs.createdAt,
      stationIds: jobs.stationIds,
    })
    .from(jobs)
    .where(whereClause)
    .orderBy(desc(jobs.createdAt))
    .limit(limit)
    .offset(offset);
  const [countRes] = await db
    .select({ total: count() })
    .from(jobs)
    .where(whereClause);
  return formatPaginatedResult(
    rows.map((r) => publicJob(r)),
    countRes?.total ?? 0,
    page,
    limit,
  );
}

// ---------------------------------------------------------------------------
// listJobsWithStations
// ---------------------------------------------------------------------------
// Used by the employee creation form:
// Each job carries its linked stations so the frontend can populate the
// station picker client-side once the user picks a job — no second call.
// ---------------------------------------------------------------------------
export interface PublicJobWithStations extends PublicJob {
  stations: Array<{ id: string; name: string }>;
}

export async function listJobsWithStations(): Promise<PublicJobWithStations[]> {
  // 1. Fetch jobs
  const jobRows = await db.select().from(jobs);
  if (jobRows.length === 0) return [];

  // 2. Fetch all unique stations referenced by jobs
  const allStationIds = new Set<string>();
  for (const j of jobRows) {
    for (const sId of j.stationIds || []) {
      allStationIds.add(sId);
    }
  }

  const stationsMap = new Map<string, { id: string; name: string }>();
  if (allStationIds.size > 0) {
    const sRows = await db
      .select({ id: stations.id, name: stations.name })
      .from(stations)
      .where(inArray(stations.id, Array.from(allStationIds)));
    for (const s of sRows) {
      stationsMap.set(s.id, s);
    }
  }

  return jobRows.map((j) => {
    const jobStations = (j.stationIds || [])
      .map((id) => stationsMap.get(id))
      .filter((s): s is { id: string; name: string } => s !== undefined);

    return {
      id: j.id,
      name: j.name,
      createdAt: j.createdAt.toISOString(),
      stationIds: j.stationIds || [],
      stations: jobStations,
    };
  });
}

// ---------------------------------------------------------------------------
// getJobStations
// ---------------------------------------------------------------------------
// Returns the stations linked to a single job by its UUID.
// Used by the employee form when the user selects a specific job and the
// frontend needs to show only the stations for that job.
// ---------------------------------------------------------------------------
export async function getJobStations(
  jobIds: string[],
): Promise<Array<{ id: string; name: string }>> {
  if (jobIds.length === 0) return [];

  const jobRows = await db
    .select({ stationIds: jobs.stationIds })
    .from(jobs)
    .where(inArray(jobs.id, jobIds));

  const allStationIds = new Set<string>();
  for (const j of jobRows) {
    for (const sId of j.stationIds || []) {
      allStationIds.add(sId);
    }
  }

  if (allStationIds.size === 0) return [];

  const sRows = await db
    .select({ id: stations.id, name: stations.name })
    .from(stations)
    .where(inArray(stations.id, Array.from(allStationIds)));

  return sRows;
}

export async function createJob(input: JobCreateInput): Promise<PublicJob> {
  const id = crypto.randomUUID();
  await db.insert(jobs).values({
    id,
    name: input.name,
    stationIds: input.stationIds || [],
  });

  const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!row) {
    throw Object.assign(new ApiError('Inserted role not found', 500), {
      errorCode: 'INTERNAL_ERROR',
    });
  }

  return publicJob(row);
}

export async function updateJob(
  id: string,
  patch: JobPatchInput,
): Promise<PublicJob> {
  if (Object.keys(patch).length === 0) {
    throw Object.assign(
      new ApiError('Patch must include at least one field', 400),
      { errorCode: 'INVALID_INPUT' },
    );
  }
  const [existing] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1);
  if (!existing) {
    throw Object.assign(new ApiError('Job not found', 404), {
      errorCode: 'ROLE_NOT_FOUND',
    });
  }

  const updatePayload: Partial<JobPatchInput> = {};
  if (patch.name !== undefined) updatePayload.name = patch.name;
  if (patch.stationIds !== undefined)
    updatePayload.stationIds = patch.stationIds;

  await db.update(jobs).set(updatePayload).where(eq(jobs.id, id));

  const [updated] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1);
  if (!updated) {
    throw Object.assign(new ApiError('Updated role not found', 500), {
      errorCode: 'INTERNAL_ERROR',
    });
  }

  return publicJob(updated);
}

export async function deleteJob(id: string): Promise<void> {
  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1);
  if (!existing) {
    throw Object.assign(new ApiError('Job not found', 404), {
      errorCode: 'ROLE_NOT_FOUND',
    });
  }
  const refs = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(employees)
    .where(sql`${id} = ANY(${employees.jobIds})`);
  const refCount = refs[0]?.c ?? 0;
  if (refCount > 0) {
    throw Object.assign(
      new ApiError(
        `Cannot delete: ${refCount} employee(s) still reference this role.`,
        409,
      ),
      { errorCode: 'ROLE_IN_USE' },
    );
  }
  await db.delete(jobs).where(eq(jobs.id, id));
}
