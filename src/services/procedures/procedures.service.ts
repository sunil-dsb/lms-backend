import ApiError from '../../shared/utils/ApiError.ts';
import crypto from 'node:crypto';
import {
  SQL,
  and,
  desc,
  eq,
  inArray,
  sql,
  count,
  ilike,
  or,
} from 'drizzle-orm';
import {
  formatPaginatedResult,
  type PaginatedResult,
} from '../../shared/utils/pagination.ts';
import { db } from '../../db/client.ts';
import { procedures, quiz, type ProcedureStatus } from '../../db/index.ts';

import { logger } from '../../config/logger.ts';
import {
  procedureBodySchema,
  type Block,
  type CreateProcedureInput,
  type UpdateProcedureInput,
  type ProcedureBody,
} from '../../db/procedure.schema.ts';
import { subcategories } from '../../db/subcategories.schema.ts';
import { categories } from '../../db/categories.schema.ts';
import { stations } from '../../db/stations.schema.ts';
import { employees } from '../../db/employee.schema.ts';
import {
  publicSubcategory,
  type PublicSubcategory,
} from '../categories/subcategories.service.ts';

// Wire shape returned by the API. Same fields as the row, with Date
// serialised to ISO and the JSON bodies parsed back to objects so the
// frontend can render without a second JSON.parse. category is the joined
// Category row — null when the procedure has no category (the row's
// category_id is null) or when the category was archived after this
// procedure was created (FK SET NULL).
export interface AssignedUserSummary {
  id: string;
  name: string;
}

export interface PublicProcedure {
  id: string;
  slug: string;
  titleEn: string;
  titleEs: string;
  purposeEn: string;
  purposeEs: string;
  subcategory: PublicSubcategory | null;
  stationIds: string[] | null;
  quizId: string | null;
  procedureImage: string | null;
  assignUsers?: AssignedUserSummary[] | string[] | null;
  isDirectlyAssigned?: boolean;
  status: ProcedureStatus;
  previousStatus: ProcedureStatus | null;
  bodyEn?: ProcedureBody;
  bodyEs?: ProcedureBody;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Parse stored JSON bodies back to the API shape. Fall back to an empty
 *  block list when the stored data doesn't validate — a single malformed row
 *  shouldn't 400 the whole list endpoint. Bad shape is logged with the row id
 *  and the first Zod issue so the offending record can be repaired. */
export function parseStoredBody(raw: unknown, where: string): ProcedureBody {
  const parsed = procedureBodySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const shape =
    raw === null
      ? 'null'
      : Array.isArray(raw)
        ? `array(len=${raw.length})`
        : typeof raw === 'object'
          ? `object(keys=${Object.keys(raw as Record<string, unknown>).join(',')})`
          : typeof raw;
  logger.warn(
    `procedure body invalid (${where}): ${first?.path?.join('.') ?? '?'} - ${first?.message ?? 'invalid'} -> ${shape}`,
  );
  return { blocks: [] };
}

// Drizzle's leftJoin selects return one row per procedure with the joined
// subcategory (or null). publicProcedure takes that row shape directly.
export function publicProcedure(
  row: Readonly<typeof procedures.$inferSelect> & {
    subcategory: typeof subcategories.$inferSelect | null;
    stations?: { id: string; name: string }[] | undefined;
  },
  options: { includeBody?: boolean } = { includeBody: true },
): PublicProcedure {
  const p = row;
  const result: PublicProcedure = {
    id: p.id,
    slug: p.slug,
    titleEn: p.titleEn,
    titleEs: p.titleEs,
    purposeEn: p.purposeEn,
    purposeEs: p.purposeEs,
    subcategory: p.subcategory ? publicSubcategory(p.subcategory) : null,
    stationIds: p.stationIds,
    quizId: p.quizId,
    procedureImage: p.procedureImage,
    assignUsers: p.assignUsers,
    status: p.status,
    previousStatus: (p.previousStatus as ProcedureStatus) ?? null,
    createdBy: p.createdBy,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };

  if (options.includeBody) {
    result.bodyEn = parseStoredBody(p.blocksEn, `${p.id}/blocksEn`);
    result.bodyEs = parseStoredBody(p.blocksEs, `${p.id}/blocksEs`);
  }

  return result;
}

export async function resolveAssignedUsers(
  userIds: string[] | null | undefined,
): Promise<AssignedUserSummary[]> {
  if (!userIds || userIds.length === 0) return [];
  const rows = await db
    .select({ id: employees.id, name: employees.name })
    .from(employees)
    .where(inArray(employees.id, userIds));
  return rows;
}

// URL-safe slug from a human title. Lowercase, ASCII, hyphens.
// Diacritics get stripped (so "Limpieza" -> "limpieza"); everything else
// non-alphanumeric becomes a hyphen; repeated/edge hyphens collapse.
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Append `-2`, `-3`, … on collision. Stops at 999 — past that we tack a
// short uuid suffix so we never loop forever.
async function generateUniqueSlug(base: string): Promise<string> {
  const seed = base.length > 0 ? base : 'untitled';
  const [hit] = await db
    .select({ slug: procedures.slug })
    .from(procedures)
    .where(eq(procedures.slug, seed))
    .limit(1);
  if (!hit) return seed;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${seed}-${i}`;
    const [exists] = await db
      .select({ slug: procedures.slug })
      .from(procedures)
      .where(eq(procedures.slug, candidate))
      .limit(1);
    if (!exists) return candidate;
  }
  return `${seed}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function createProcedure(
  input: CreateProcedureInput,
  actor: { employeeId: string; userId?: string | undefined },
): Promise<PublicProcedure> {
  const bodyEn = procedureBodySchema.parse(input.bodyEn);
  const bodyEs = procedureBodySchema.parse(input.bodyEs);

  // Recipe cross-field rule: ingredients and factors travel together. If
  // either is set, both must be set, and every ingredient's amounts row
  // length must equal the factors length. Throws ServiceError so the
  // controller surfaces a clean 400. Walk every recipe block in both
  // language bodies.
  assertRecipeIngredientsAlign(bodyEn.blocks, 'en');
  assertRecipeIngredientsAlign(bodyEs.blocks, 'es');

  if (input.status === 'published') {
    assertCanPublish({
      titleEn: input.titleEn,
      titleEs: input.titleEs,
      purposeEn: input.purposeEn,
      purposeEs: input.purposeEs,
      subcategoryId: input.subcategoryId,
      stationIds: input.stationIds,
      blocksEn: bodyEn,
      blocksEs: bodyEs,
    });
  }

  // Method-block cross-field rule: every step marked critical must declare
  // a criticalLimit. Applies to method blocks AND the steps inside recipe
  // blocks (recipes have methods too).

  if (input.stationIds && input.stationIds.length > 0) {
    const st = await db
      .select({ id: stations.id })
      .from(stations)
      .where(inArray(stations.id, input.stationIds));
    if (st.length !== input.stationIds.length) {
      throw Object.assign(new ApiError('Station not found', 404), {
        errorCode: 'STATION_NOT_FOUND',
      });
    }
  }

  // Verify the picked subcategory exists. The FK has
  // SET NULL semantics — an invalid id would corrupt the row silently — so
  // we surface a clean 400 / 404 here.
  if (input.subcategoryId != null) {
    const [subcat] = await db
      .select({ id: subcategories.id, categoryStatus: categories.status })
      .from(subcategories)
      .innerJoin(categories, eq(categories.id, subcategories.categoryId))
      .where(eq(subcategories.id, input.subcategoryId))
      .limit(1);
    if (!subcat) {
      throw Object.assign(new ApiError('Subcategory not found', 404), {
        errorCode: 'SUBCATEGORY_NOT_FOUND',
      });
    }
    if (subcat.categoryStatus === 'archived') {
      throw Object.assign(
        new ApiError(
          'Cannot assign procedure to a subcategory of an archived category',
          400,
        ),
        { errorCode: 'CATEGORY_ARCHIVED' },
      );
    }
  }

  if (input.quizId != null) {
    // For now we don't strictly validate quiz existence, just let the DB throw a FK error
    // or we can add it later when Quizzes are fully implemented
  }

  // Validate assignUsers to ensure they are valid employees (and not super_admins)
  if (input.assignUsers && input.assignUsers.length > 0) {
    const assigned = await db
      .select({ id: employees.id, role: employees.role })
      .from(employees)
      .where(
        sql`${employees.id} = ANY(ARRAY[${sql.join(
          input.assignUsers.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}])`,
      );

    if (assigned.length !== input.assignUsers.length) {
      throw Object.assign(
        new ApiError('One or more assigned users do not exist', 400),
        {
          errorCode: 'ASSIGNED_USER_NOT_FOUND',
        },
      );
    }

    const invalidRoles = assigned.filter((a) => a.role !== 'employee');
    if (invalidRoles.length > 0) {
      throw Object.assign(
        new ApiError(
          'Only users with the employee role can be assigned to procedures',
          400,
        ),
        { errorCode: 'INVALID_ASSIGNED_USER_ROLE' },
      );
    }
  }

  const id = crypto.randomUUID();
  const slug = await generateUniqueSlug(slugify(input.titleEn));

  await db.insert(procedures).values({
    id,
    slug,
    titleEn: input.titleEn,
    titleEs: input.titleEs,
    purposeEn: input.purposeEn,
    purposeEs: input.purposeEs,
    subcategoryId: input.subcategoryId,
    stationIds: input.stationIds ?? null,
    quizId: input.quizId ?? null,
    procedureImage: input.procedureImage ?? null,
    assignUsers: input.assignUsers ?? null,
    status: input.status,
    blocksEn: bodyEn,
    blocksEs: bodyEs,
    createdBy: actor.userId || null,
  });

  const [row] = await db
    .select({
      proc: procedures,
      subcategory: subcategories,
    })
    .from(procedures)
    .leftJoin(subcategories, eq(subcategories.id, procedures.subcategoryId))
    .where(eq(procedures.id, id))
    .limit(1);
  if (!row) {
    throw Object.assign(new ApiError('Inserted procedure not found', 500), {
      errorCode: 'INTERNAL_ERROR',
    });
  }
  const pub = publicProcedure({
    ...row.proc,
    subcategory: row.subcategory,
  });
  if (row.proc.assignUsers && row.proc.assignUsers.length > 0) {
    pub.assignUsers = await resolveAssignedUsers(row.proc.assignUsers);
  }
  return pub;
}

/** Update an existing procedure by ID. Follows the same validation as create. */
export async function updateProcedure(
  id: string,
  input: UpdateProcedureInput,
): Promise<PublicProcedure> {
  const [existing] = await db
    .select()
    .from(procedures)
    .where(eq(procedures.id, id))
    .limit(1);

  if (!existing) {
    throw Object.assign(new ApiError('Procedure not found', 404), {
      errorCode: 'NOT_FOUND',
    });
  }

  let bodyEn, bodyEs;

  if (input.bodyEn !== undefined) {
    bodyEn = procedureBodySchema.parse(input.bodyEn);
    assertRecipeIngredientsAlign(bodyEn.blocks, 'en');
  }

  if (input.bodyEs !== undefined) {
    bodyEs = procedureBodySchema.parse(input.bodyEs);
    assertRecipeIngredientsAlign(bodyEs.blocks, 'es');
  }

  const targetStatus = input.status ?? existing.status;
  if (targetStatus === 'published') {
    assertCanPublish({
      titleEn: input.titleEn ?? existing.titleEn,
      titleEs: input.titleEs ?? existing.titleEs,
      purposeEn: input.purposeEn ?? existing.purposeEn,
      purposeEs: input.purposeEs ?? existing.purposeEs,
      subcategoryId:
        input.subcategoryId !== undefined
          ? input.subcategoryId
          : existing.subcategoryId,
      stationIds:
        input.stationIds !== undefined ? input.stationIds : existing.stationIds,
      blocksEn: bodyEn ?? existing.blocksEn,
      blocksEs: bodyEs ?? existing.blocksEs,
    });
  }

  if (input.subcategoryId !== undefined && input.subcategoryId !== null) {
    const [subcat] = await db
      .select({ id: subcategories.id, categoryStatus: categories.status })
      .from(subcategories)
      .innerJoin(categories, eq(categories.id, subcategories.categoryId))
      .where(eq(subcategories.id, input.subcategoryId))
      .limit(1);
    if (!subcat) {
      throw Object.assign(new ApiError('Subcategory not found', 404), {
        errorCode: 'SUBCATEGORY_NOT_FOUND',
      });
    }
    if (subcat.categoryStatus === 'archived') {
      throw Object.assign(
        new ApiError(
          'Cannot assign procedure to a subcategory of an archived category',
          400,
        ),
        { errorCode: 'CATEGORY_ARCHIVED' },
      );
    }
  }

  if (input.stationIds && input.stationIds.length > 0) {
    const st = await db
      .select({ id: stations.id })
      .from(stations)
      .where(inArray(stations.id, input.stationIds));
    if (st.length !== input.stationIds.length) {
      throw Object.assign(new ApiError('Station not found', 404), {
        errorCode: 'STATION_NOT_FOUND',
      });
    }
  }

  if (input.assignUsers && input.assignUsers.length > 0) {
    const assigned = await db
      .select({ id: employees.id, role: employees.role })
      .from(employees)
      .where(
        sql`${employees.id} = ANY(ARRAY[${sql.join(
          input.assignUsers.map((uid) => sql`${uid}::uuid`),
          sql`, `,
        )}])`,
      );

    if (assigned.length !== input.assignUsers.length) {
      throw Object.assign(
        new ApiError('One or more assigned users do not exist', 400),
        { errorCode: 'ASSIGNED_USER_NOT_FOUND' },
      );
    }
    const invalidRoles = assigned.filter((a) => a.role !== 'employee');
    if (invalidRoles.length > 0) {
      throw Object.assign(
        new ApiError(
          'Only users with the employee role can be assigned to procedures',
          400,
        ),
        { errorCode: 'INVALID_ASSIGNED_USER_ROLE' },
      );
    }
  }

  await db
    .update(procedures)
    .set({
      ...(input.titleEn !== undefined && { titleEn: input.titleEn }),
      ...(input.titleEs !== undefined && { titleEs: input.titleEs }),
      ...(input.purposeEn !== undefined && { purposeEn: input.purposeEn }),
      ...(input.purposeEs !== undefined && { purposeEs: input.purposeEs }),
      ...(input.subcategoryId !== undefined && {
        subcategoryId: input.subcategoryId,
      }),
      ...(input.stationIds !== undefined && { stationIds: input.stationIds }),
      ...(input.quizId !== undefined && { quizId: input.quizId }),
      ...(input.procedureImage !== undefined && {
        procedureImage: input.procedureImage,
      }),
      ...(input.assignUsers !== undefined && {
        assignUsers: input.assignUsers,
      }),
      ...(input.status !== undefined && { status: input.status }),
      ...(bodyEn !== undefined && { blocksEn: bodyEn }),
      ...(bodyEs !== undefined && { blocksEs: bodyEs }),
      updatedAt: new Date(),
    })
    .where(eq(procedures.id, id));

  const [row] = await db
    .select({
      proc: procedures,
      subcategory: subcategories,
    })
    .from(procedures)
    .leftJoin(subcategories, eq(subcategories.id, procedures.subcategoryId))
    .where(eq(procedures.id, id))
    .limit(1);

  if (!row) {
    throw Object.assign(new ApiError('Updated procedure not found', 500), {
      errorCode: 'INTERNAL_ERROR',
    });
  }
  const pub = publicProcedure({
    ...row.proc,
    subcategory: row.subcategory,
  });
  if (row.proc.assignUsers && row.proc.assignUsers.length > 0) {
    pub.assignUsers = await resolveAssignedUsers(row.proc.assignUsers);
  }
  return pub;
}

/** Admin-only list of procedures. Newest first. Optionally filtered by:
 *  - `status`         – 'draft' | 'published'
 *  - `stationIds`     – one or more station UUIDs (OR semantics)
 *  - `subcategoryIds` – one or more subcategory UUIDs (OR semantics)
 *  - `categoryIds`    – one or more category UUIDs (OR semantics)
 *  - `categoryType`   – category_type exact match, case-insensitive
 *    (e.g. 'general' or station-based types). AND-combined with the rest.
 *
 *  Returns the full public shape so the editor can re-open a draft without a
 *  second fetch. */
export async function listProcedures(
  filter: {
    status?: ProcedureStatus | undefined;
    stationIds?: string[] | undefined;
    assignedEmployeeId?: string | undefined;
    scope?: string | undefined;
    subcategoryIds?: string[] | undefined;
    categoryIds?: string[] | undefined;
    categoryType?: string | undefined;
    search?: string | undefined;
    includeBody?: boolean | undefined;
  } = {},
  page: number = 1,
  limit: number = 10,
): Promise<PaginatedResult<PublicProcedure>> {
  const conditions: SQL[] = [];

  if (filter.status) {
    conditions.push(eq(procedures.status, filter.status));
  }

  if (filter.assignedEmployeeId) {
    const empId = filter.assignedEmployeeId;
    const hasStations = filter.stationIds && filter.stationIds.length > 0;
    const userMatch = sql`${procedures.assignUsers} && ARRAY[${empId}::uuid]`;
    const stationMatch = hasStations
      ? sql`${procedures.stationIds} && ARRAY[${sql.join(
          filter.stationIds!.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`
      : undefined;

    if (filter.scope === 'mine') {
      conditions.push(userMatch);
    } else {
      // Default: 'all'
      if (stationMatch) {
        conditions.push(or(stationMatch, userMatch)!);
      } else {
        conditions.push(userMatch);
      }
    }
  } else if (filter.stationIds && filter.stationIds.length > 0) {
    conditions.push(
      sql`${procedures.stationIds} && ${sql`ARRAY[${sql.join(
        filter.stationIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`}`,
    );
  }

  if (filter.subcategoryIds && filter.subcategoryIds.length > 0) {
    conditions.push(inArray(procedures.subcategoryId, filter.subcategoryIds));
  }

  if (filter.categoryIds && filter.categoryIds.length > 0) {
    conditions.push(inArray(subcategories.categoryId, filter.categoryIds));
  }

  if (filter.categoryType && filter.categoryType.trim().length > 0) {
    conditions.push(
      sql`lower(${categories.categoryType}) = lower(${filter.categoryType.trim()})`,
    );
  }

  if (filter.search) {
    conditions.push(
      or(
        ilike(procedures.titleEn, `%${filter.search}%`),
        ilike(procedures.titleEs, `%${filter.search}%`),
      )!,
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (page - 1) * limit;

  const rows = await db
    .select({ proc: procedures, subcategory: subcategories })
    .from(procedures)
    .leftJoin(subcategories, eq(subcategories.id, procedures.subcategoryId))
    .leftJoin(categories, eq(categories.id, subcategories.categoryId))
    .where(whereClause)
    .orderBy(desc(procedures.updatedAt))
    .limit(limit)
    .offset(offset);

  const [countRes] = await db
    .select({ total: count() })
    .from(procedures)
    .leftJoin(subcategories, eq(subcategories.id, procedures.subcategoryId))
    .leftJoin(categories, eq(categories.id, subcategories.categoryId))
    .where(whereClause);

  const allAssignedIds = new Set<string>();
  for (const row of rows) {
    if (row.proc.assignUsers) {
      for (const uid of row.proc.assignUsers) {
        allAssignedIds.add(uid);
      }
    }
  }

  const userMap = new Map<string, { id: string; name: string }>();
  if (allAssignedIds.size > 0) {
    const userRows = await db
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      .where(inArray(employees.id, Array.from(allAssignedIds)));
    for (const u of userRows) {
      userMap.set(u.id, u);
    }
  }

  const mapped = rows.map((row) => {
    const pub = publicProcedure(
      { ...row.proc, subcategory: row.subcategory },
      { includeBody: filter.includeBody ?? false },
    );
    if (filter.assignedEmployeeId) {
      pub.isDirectlyAssigned = Boolean(
        row.proc.assignUsers &&
        filter.assignedEmployeeId &&
        row.proc.assignUsers.includes(filter.assignedEmployeeId),
      );
      delete pub.assignUsers;
    } else if (row.proc.assignUsers && row.proc.assignUsers.length > 0) {
      pub.assignUsers = row.proc.assignUsers.map(
        (uid) => userMap.get(uid) ?? { id: uid, name: 'Unknown' },
      );
    }
    return pub;
  });
  return formatPaginatedResult(mapped, countRes?.total ?? 0, page, limit);
}

/** Fetch a single procedure by slug (used by the public doc view). Returns
 *  `null` when the slug doesn't match anything — the caller decides whether
 *  that's a 404 or just an empty result. Works for both drafts and published;
 *  status-based gating happens at the route layer. */
export async function getProcedureBySlug(
  slug: string,
  actor?:
    | {
        role?: string | undefined;
        employeeId?: string | undefined;
        isSuperAdmin?: boolean | undefined;
      }
    | undefined,
): Promise<PublicProcedure | null> {
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      slug,
    );
  const condition = isUuid
    ? or(eq(procedures.id, slug), eq(procedures.slug, slug))
    : eq(procedures.slug, slug);

  const [row] = await db
    .select({ proc: procedures, subcategory: subcategories })
    .from(procedures)
    .leftJoin(subcategories, eq(subcategories.id, procedures.subcategoryId))
    .where(condition)
    .limit(1);
  if (!row) return null;

  const pub = publicProcedure({ ...row.proc, subcategory: row.subcategory });

  const isAdmin =
    Boolean(actor?.isSuperAdmin) ||
    actor?.role === 'super_admin' ||
    actor?.role === 'manager';

  if (isAdmin) {
    pub.assignUsers = await resolveAssignedUsers(row.proc.assignUsers);
  } else {
    const employeeId = actor?.employeeId;
    pub.isDirectlyAssigned = Boolean(
      employeeId &&
      row.proc.assignUsers &&
      row.proc.assignUsers.includes(employeeId),
    );
    delete pub.assignUsers;
  }

  return pub;
}

/** Archive a procedure (draft → archived or published → archived).
 *  Saves the current status in `previousStatus` so it can be restored.
 *  Throws 404 when the id doesn't exist or the procedure is already archived. */
export async function archiveProcedure(id: string): Promise<PublicProcedure> {
  const [existing] = await db
    .select({ proc: procedures, subcategory: subcategories })
    .from(procedures)
    .leftJoin(subcategories, eq(subcategories.id, procedures.subcategoryId))
    .where(eq(procedures.id, id))
    .limit(1);

  if (!existing) {
    throw Object.assign(new ApiError('Procedure not found', 404), {
      errorCode: 'NOT_FOUND',
    });
  }

  if (existing.proc.status === 'archived') {
    throw Object.assign(new ApiError('Procedure is already archived', 409), {
      errorCode: 'ALREADY_ARCHIVED',
    });
  }

  const now = new Date();
  await db
    .update(procedures)
    .set({
      previousStatus: existing.proc.status,
      status: 'archived',
      updatedAt: now,
    })
    .where(eq(procedures.id, id));

  return publicProcedure({
    ...existing.proc,
    status: 'archived',
    previousStatus: existing.proc.status,
    updatedAt: now,
    subcategory: existing.subcategory,
  });
}

/** Unarchive a procedure — restores it to its `previousStatus` (draft or
 *  published). Falls back to 'draft' if no previousStatus was recorded.
 *  Throws 404 when the id doesn't exist or the procedure is not archived. */
export async function unarchiveProcedure(id: string): Promise<PublicProcedure> {
  const [existing] = await db
    .select({ proc: procedures, subcategory: subcategories })
    .from(procedures)
    .leftJoin(subcategories, eq(subcategories.id, procedures.subcategoryId))
    .where(eq(procedures.id, id))
    .limit(1);

  if (!existing) {
    throw Object.assign(new ApiError('Procedure not found', 404), {
      errorCode: 'NOT_FOUND',
    });
  }

  if (existing.proc.status !== 'archived') {
    throw Object.assign(new ApiError('Procedure is not archived', 409), {
      errorCode: 'NOT_ARCHIVED',
    });
  }

  const restoreStatus: ProcedureStatus =
    (existing.proc.previousStatus as ProcedureStatus) ?? 'draft';

  const now = new Date();
  await db
    .update(procedures)
    .set({
      status: restoreStatus,
      previousStatus: null,
      updatedAt: now,
    })
    .where(eq(procedures.id, id));

  return publicProcedure({
    ...existing.proc,
    status: restoreStatus,
    previousStatus: null,
    updatedAt: now,
    subcategory: existing.subcategory,
  });
}

/** Update the station links of a procedure (array, null clears). */
export async function updateProcedureStations(
  id: string,
  stationIds: string[] | null,
): Promise<PublicProcedure> {
  const ids = stationIds ?? [];
  if (ids.length > 0) {
    const st = await db
      .select({ id: stations.id })
      .from(stations)
      .where(inArray(stations.id, ids));
    if (st.length !== ids.length) {
      throw Object.assign(new ApiError('Station not found', 404), {
        errorCode: 'STATION_NOT_FOUND',
      });
    }
  }
  const now = new Date();
  await db
    .update(procedures)
    .set({ stationIds: ids.length > 0 ? ids : null, updatedAt: now })
    .where(eq(procedures.id, id));
  const [row] = await db
    .select({ proc: procedures, subcategory: subcategories })
    .from(procedures)
    .leftJoin(subcategories, eq(subcategories.id, procedures.subcategoryId))
    .where(eq(procedures.id, id))
    .limit(1);
  if (!row) {
    throw Object.assign(new ApiError('Procedure not found', 404), {
      errorCode: 'NOT_FOUND',
    });
  }
  return publicProcedure({ ...row.proc, subcategory: row.subcategory });
}

/** Publish a procedure (draft → published).
 *  Throws 404 when the id doesn't exist, 409 when already published or archived. */
export async function publishProcedure(id: string): Promise<PublicProcedure> {
  const [existing] = await db
    .select({ proc: procedures, subcategory: subcategories })
    .from(procedures)
    .leftJoin(subcategories, eq(subcategories.id, procedures.subcategoryId))
    .where(eq(procedures.id, id))
    .limit(1);

  if (!existing) {
    throw Object.assign(new ApiError('Procedure not found', 404), {
      errorCode: 'NOT_FOUND',
    });
  }

  if (existing.proc.status === 'published') {
    throw Object.assign(new ApiError('Procedure is already published', 409), {
      errorCode: 'ALREADY_PUBLISHED',
    });
  }

  if (existing.proc.status === 'archived') {
    throw Object.assign(
      new ApiError(
        'Archived procedure cannot be published. Unarchive it first.',
        409,
      ),
      { errorCode: 'ARCHIVED' },
    );
  }

  assertCanPublish({
    titleEn: existing.proc.titleEn,
    titleEs: existing.proc.titleEs,
    purposeEn: existing.proc.purposeEn,
    purposeEs: existing.proc.purposeEs,
    subcategoryId: existing.proc.subcategoryId,
    stationIds: existing.proc.stationIds,
    blocksEn: existing.proc.blocksEn,
    blocksEs: existing.proc.blocksEs,
  });

  const now = new Date();
  await db
    .update(procedures)
    .set({ status: 'published', updatedAt: now })
    .where(eq(procedures.id, id));

  return publicProcedure({
    ...existing.proc,
    status: 'published',
    updatedAt: now,
    subcategory: existing.subcategory,
  });
}

/** Delete a procedure by ID.
 *  Also cascade deletes any quiz linked to this procedure.
 *  Throws 404 when the id doesn't exist. */
export async function deleteProcedure(id: string): Promise<void> {
  const [existing] = await db
    .select({ id: procedures.id, quizId: procedures.quizId })
    .from(procedures)
    .where(eq(procedures.id, id))
    .limit(1);

  if (!existing) {
    throw Object.assign(new ApiError('Procedure not found', 404), {
      errorCode: 'NOT_FOUND',
    });
  }

  await db.delete(procedures).where(eq(procedures.id, id));

  // If this procedure had a linked quiz, delete it as well (if no other procedure shares it)
  if (existing.quizId) {
    const [otherProc] = await db
      .select({ id: procedures.id })
      .from(procedures)
      .where(eq(procedures.quizId, existing.quizId))
      .limit(1);

    if (!otherProc) {
      await db.delete(quiz).where(eq(quiz.id, existing.quizId));
    }
  }
}

function assertRecipeIngredientsAlign(
  blocks: Block[],
  lang: 'en' | 'es',
): void {
  for (const block of blocks) {
    if (block.kind !== 'ingredients') continue;
    const recipe = block;
    const hasIngredients = (recipe.ingredients?.length ?? 0) > 0;
    const hasFactors = (recipe.factors?.length ?? 0) > 0;
    if (hasIngredients !== hasFactors) {
      throw Object.assign(
        new ApiError(
          `Block ingredients and factors must be set together (${lang}).`,
          400,
        ),
        { errorCode: 'INVALID_INPUT' },
      );
    }
    if (!hasIngredients || !recipe.factors || !recipe.ingredients) continue;
    const expected = recipe.factors.length;
    for (const ingredient of recipe.ingredients) {
      if (ingredient.amounts.length !== expected) {
        throw Object.assign(
          new ApiError(
            `Ingredient "${ingredient.name}" has ${ingredient.amounts.length} amounts but ${expected} factors are defined (${lang}).`,
            400,
          ),
          { errorCode: 'INVALID_INPUT' },
        );
      }
    }
  }
}

function extractBlocks(raw: unknown): unknown[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (
    typeof raw === 'object' &&
    'blocks' in raw &&
    Array.isArray((raw as { blocks: unknown[] }).blocks)
  ) {
    return (raw as { blocks: unknown[] }).blocks;
  }
  return [];
}

export function assertCanPublish(procedure: {
  titleEn?: string | null | undefined;
  titleEs?: string | null | undefined;
  purposeEn?: string | null | undefined;
  purposeEs?: string | null | undefined;
  subcategoryId?: string | null | undefined;
  stationIds?: string[] | null | undefined;
  blocksEn?: unknown;
  blocksEs?: unknown;
}): void {
  if (!procedure.titleEn || procedure.titleEn.trim().length === 0) {
    throw Object.assign(
      new ApiError('English title is required to publish a procedure.', 400),
      { errorCode: 'TITLE_EN_REQUIRED' },
    );
  }

  if (!procedure.titleEs || procedure.titleEs.trim().length === 0) {
    throw Object.assign(
      new ApiError('Spanish title is required to publish a procedure.', 400),
      { errorCode: 'TITLE_ES_REQUIRED' },
    );
  }

  if (!procedure.purposeEn || procedure.purposeEn.trim().length === 0) {
    throw Object.assign(
      new ApiError('English purpose is required to publish a procedure.', 400),
      { errorCode: 'PURPOSE_EN_REQUIRED' },
    );
  }

  if (!procedure.purposeEs || procedure.purposeEs.trim().length === 0) {
    throw Object.assign(
      new ApiError('Spanish purpose is required to publish a procedure.', 400),
      { errorCode: 'PURPOSE_ES_REQUIRED' },
    );
  }

  if (!procedure.subcategoryId || procedure.subcategoryId.trim().length === 0) {
    throw Object.assign(
      new ApiError(
        'Category/subcategory is required to publish a procedure.',
        400,
      ),
      { errorCode: 'SUBCATEGORY_REQUIRED' },
    );
  }

  if (!procedure.stationIds || procedure.stationIds.length === 0) {
    throw Object.assign(
      new ApiError(
        'At least one station is required to publish a procedure.',
        400,
      ),
      { errorCode: 'STATIONS_REQUIRED' },
    );
  }

  const enBlocks = extractBlocks(procedure.blocksEn);
  if (enBlocks.length === 0) {
    throw Object.assign(
      new ApiError(
        'English procedure body must contain at least one component/block to publish.',
        400,
      ),
      { errorCode: 'BODY_EN_BLOCKS_REQUIRED' },
    );
  }

  const esBlocks = extractBlocks(procedure.blocksEs);
  if (esBlocks.length === 0) {
    throw Object.assign(
      new ApiError(
        'Spanish procedure body must contain at least one component/block to publish.',
        400,
      ),
      { errorCode: 'BODY_ES_BLOCKS_REQUIRED' },
    );
  }
}
