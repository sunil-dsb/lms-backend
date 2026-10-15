import ApiError from '../../shared/utils/ApiError.ts';
import crypto from 'node:crypto';
import { eq, asc, count, ilike, or, and, SQL } from 'drizzle-orm';
import {
  formatPaginatedResult,
  type PaginatedResult,
} from '../../shared/utils/pagination.ts';
import { db } from '../../db/client.ts';
import { categories } from '../../db/categories.schema.ts';
import {
  subcategories,
  type SubcategoryStatus,
} from '../../db/subcategories.schema.ts';

export interface PublicSubcategory {
  id: string;
  categoryId: string;
  nameEn: string;
  nameEs: string;
  subcategoryIcon: string;
  status: SubcategoryStatus;
  categoryStatus: string;
}

export function publicSubcategory(
  s: Readonly<typeof subcategories.$inferSelect>,
  categoryStatus: string = 'active',
): PublicSubcategory {
  return {
    id: s.id,
    categoryId: s.categoryId,
    nameEn: s.nameEn,
    nameEs: s.nameEs,
    subcategoryIcon: s.subcategoryIcon,
    status: (categoryStatus === 'archived'
      ? 'archived'
      : s.status) as SubcategoryStatus,
    categoryStatus,
  };
}

export async function listSubcategories(
  categoryId?: string,
  page: number = 1,
  limit: number = 10,
  search?: string,
  status: SubcategoryStatus | 'all' = 'active',
): Promise<PaginatedResult<PublicSubcategory>> {
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [];
  if (categoryId) {
    conditions.push(eq(subcategories.categoryId, categoryId));
  }
  // Simply check the status of the category!
  if (status !== 'all') {
    conditions.push(eq(categories.status, status));
  }
  if (search) {
    conditions.push(
      or(
        ilike(subcategories.nameEn, `%${search}%`),
        ilike(subcategories.nameEs, `%${search}%`),
      )!,
    );
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      sub: subcategories,
      categoryStatus: categories.status,
    })
    .from(subcategories)
    .innerJoin(categories, eq(categories.id, subcategories.categoryId))
    .where(whereClause)
    .orderBy(asc(subcategories.createdAt))
    .limit(limit)
    .offset(offset);

  const [countRes] = await db
    .select({ total: count() })
    .from(subcategories)
    .innerJoin(categories, eq(categories.id, subcategories.categoryId))
    .where(whereClause);

  return formatPaginatedResult(
    rows.map((r) => publicSubcategory(r.sub, r.categoryStatus)),
    countRes?.total ?? 0,
    page,
    limit,
  );
}

export interface SubcategoryCreateInput {
  nameEn: string;
  nameEs: string;
  subcategoryIcon: string;
}

export async function createSubcategory(
  categoryId: string,
  input: SubcategoryCreateInput,
  actor: { userId: string },
): Promise<PublicSubcategory> {
  const [cat] = await db
    .select({ id: categories.id, status: categories.status })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1);
  if (!cat) {
    throw Object.assign(new ApiError('Category not found', 404), {
      errorCode: 'CATEGORY_NOT_FOUND',
    });
  }

  if (cat.status === 'archived') {
    throw Object.assign(
      new ApiError('Cannot create a subcategory in an archived category', 400),
      { errorCode: 'CATEGORY_ARCHIVED' },
    );
  }

  const id = crypto.randomUUID();
  await db.insert(subcategories).values({
    id,
    categoryId,
    nameEn: input.nameEn,
    nameEs: input.nameEs,
    subcategoryIcon: input.subcategoryIcon,
    status: 'active',
    createdBy: actor.userId,
  });

  const [row] = await db
    .select()
    .from(subcategories)
    .where(eq(subcategories.id, id))
    .limit(1);
  return publicSubcategory(row!);
}

export interface SubcategoryPatchInput {
  nameEn?: string | undefined;
  nameEs?: string | undefined;
  subcategoryIcon?: string | undefined;
}

export async function updateSubcategory(
  id: string,
  patch: SubcategoryPatchInput,
): Promise<PublicSubcategory> {
  if (Object.keys(patch).length === 0) {
    throw Object.assign(
      new ApiError('Patch must include at least one field', 400),
      { errorCode: 'INVALID_INPUT' },
    );
  }

  const existing = await db
    .update(subcategories)
    .set(patch)
    .where(eq(subcategories.id, id))
    .returning({ id: subcategories.id });
  if (existing.length === 0) {
    throw Object.assign(new ApiError('Subcategory not found', 404), {
      errorCode: 'SUBCATEGORY_NOT_FOUND',
    });
  }
  const [row] = await db
    .select()
    .from(subcategories)
    .where(eq(subcategories.id, id))
    .limit(1);
  return publicSubcategory(row!);
}

export async function deleteSubcategory(id: string): Promise<void> {
  const [existing] = await db
    .select({ id: subcategories.id })
    .from(subcategories)
    .where(eq(subcategories.id, id))
    .limit(1);
  if (!existing) {
    throw Object.assign(new ApiError('Subcategory not found', 404), {
      errorCode: 'SUBCATEGORY_NOT_FOUND',
    });
  }
  await db.delete(subcategories).where(eq(subcategories.id, id));
}

export async function archiveSubcategory(
  id: string,
): Promise<PublicSubcategory> {
  const [existing] = await db
    .select()
    .from(subcategories)
    .where(eq(subcategories.id, id))
    .limit(1);

  if (!existing) {
    throw Object.assign(new ApiError('Subcategory not found', 404), {
      errorCode: 'SUBCATEGORY_NOT_FOUND',
    });
  }

  if (existing.status === 'archived') {
    throw Object.assign(new ApiError('Subcategory is already archived', 409), {
      errorCode: 'ALREADY_ARCHIVED',
    });
  }

  const [row] = await db
    .update(subcategories)
    .set({ status: 'archived' })
    .where(eq(subcategories.id, id))
    .returning();

  return publicSubcategory(row!);
}

export async function unarchiveSubcategory(
  id: string,
): Promise<PublicSubcategory> {
  const [existing] = await db
    .select({
      sub: subcategories,
      catStatus: categories.status,
    })
    .from(subcategories)
    .innerJoin(categories, eq(categories.id, subcategories.categoryId))
    .where(eq(subcategories.id, id))
    .limit(1);

  if (!existing) {
    throw Object.assign(new ApiError('Subcategory not found', 404), {
      errorCode: 'SUBCATEGORY_NOT_FOUND',
    });
  }

  if (existing.sub.status !== 'archived') {
    throw Object.assign(new ApiError('Subcategory is not archived', 409), {
      errorCode: 'NOT_ARCHIVED',
    });
  }

  if (existing.catStatus === 'archived') {
    throw Object.assign(
      new ApiError(
        'Cannot unarchive subcategory while its parent category is archived. Unarchive the category first.',
        400,
      ),
      { errorCode: 'CATEGORY_ARCHIVED' },
    );
  }

  const [row] = await db
    .update(subcategories)
    .set({ status: 'active' })
    .where(eq(subcategories.id, id))
    .returning();

  return publicSubcategory(row!);
}

export async function getSubcategoryById(
  id: string,
): Promise<PublicSubcategory> {
  const [row] = await db
    .select({
      sub: subcategories,
      categoryStatus: categories.status,
    })
    .from(subcategories)
    .innerJoin(categories, eq(categories.id, subcategories.categoryId))
    .where(eq(subcategories.id, id))
    .limit(1);
  if (!row) {
    throw Object.assign(new ApiError('Subcategory not found', 404), {
      errorCode: 'SUBCATEGORY_NOT_FOUND',
    });
  }
  return publicSubcategory(row.sub, row.categoryStatus);
}
