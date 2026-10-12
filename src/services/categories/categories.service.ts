import ApiError from '../../shared/utils/ApiError.ts';
import crypto from 'node:crypto';
import { asc, eq, count, ilike, or, SQL } from 'drizzle-orm';
import {
  formatPaginatedResult,
  type PaginatedResult,
} from '../../shared/utils/pagination.ts';
import { db } from '../../db/client.ts';
import { categories } from '../../db/categories.schema.ts';
import { subcategories } from '../../db/subcategories.schema.ts';

export interface PublicCategory {
  id: string;
  nameEn: string;
  nameEs: string;
  categoryType: string;
  categoryIcon: string;
}

export function publicCategory(
  row: Readonly<typeof categories.$inferSelect>,
): PublicCategory {
  return {
    id: row.id,
    nameEn: row.nameEn,
    nameEs: row.nameEs,
    categoryType: row.categoryType,
    categoryIcon: row.categoryIcon,
  };
}

export interface CategoryCreateInput {
  nameEn: string;
  nameEs: string;
  categoryType: string;
  categoryIcon: string;
}

export interface CategoryPatchInput {
  nameEn?: string | undefined;
  nameEs?: string | undefined;
  categoryType?: string | undefined;
  categoryIcon?: string | undefined;
}

// Ordered insertion-first (created_at ASC), slug tie-break. The manager can
// reshuffle later by renaming + archiving; if the team actually wants a
// drag-and-drop re-order UI we'll add a sort_order column in a follow-up.
export async function listCategories(
  page: number = 1,
  limit: number = 10,
  search?: string,
): Promise<PaginatedResult<PublicCategory>> {
  const offset = (page - 1) * limit;
  const conditions: SQL[] = [];
  if (search) {
    conditions.push(
      or(
        ilike(categories.nameEn, `%${search}%`),
        ilike(categories.nameEs, `%${search}%`),
      )!,
    );
  }
  const whereClause = conditions.length ? conditions[0] : undefined;

  const rows = await db
    .select()
    .from(categories)
    .where(whereClause)
    .orderBy(asc(categories.createdAt))
    .limit(limit)
    .offset(offset);

  const [countRes] = await db
    .select({ total: count() })
    .from(categories)
    .where(whereClause);

  return formatPaginatedResult(
    rows.map(publicCategory),
    countRes?.total ?? 0,
    page,
    limit,
  );
}

export async function createCategory(
  input: CategoryCreateInput,
  actor: { userId: string },
): Promise<PublicCategory> {
  const nameEn = input.nameEn.trim();
  const nameEs = input.nameEs.trim();
  const categoryType = input.categoryType.trim();
  const categoryIcon = input.categoryIcon.trim();
  if (
    nameEn.length === 0 ||
    nameEs.length === 0 ||
    categoryType.length === 0 ||
    categoryIcon.length === 0
  ) {
    throw Object.assign(
      new ApiError(
        'nameEn, nameEs, categoryType, and categoryIcon are required',
        400,
      ),
      {
        errorCode: 'INVALID_INPUT',
      },
    );
  }

  if (nameEn.length > 200 || nameEs.length > 200) {
    throw Object.assign(
      new ApiError('Names must be 200 characters or fewer', 400),
      { errorCode: 'INVALID_INPUT' },
    );
  }

  const id = crypto.randomUUID();
  await db.insert(categories).values({
    id,
    nameEn,
    nameEs,
    categoryType,
    categoryIcon,
    createdBy: actor.userId,
  });

  const [row] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, id))
    .limit(1);
  return publicCategory(row!);
}

export interface SubcategoryCreateInput {
  nameEn: string;
  nameEs: string;
}

export async function createSubcategory(
  categoryId: string,
  input: SubcategoryCreateInput,
  actor: { userId: string },
) {
  const [category] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1);
  if (!category) {
    throw Object.assign(new ApiError('Category not found', 404), {
      errorCode: 'CATEGORY_NOT_FOUND',
    });
  }

  const id = crypto.randomUUID();
  await db.insert(subcategories).values({
    id,
    categoryId,
    nameEn: input.nameEn,
    nameEs: input.nameEs,
    createdBy: actor.userId,
    subcategoryIcon: '',
  });

  const [row] = await db
    .select()
    .from(subcategories)
    .where(eq(subcategories.id, id))
    .limit(1);
  return row;
}

export async function updateCategory(id: string, patch: CategoryPatchInput) {
  if (Object.keys(patch).length === 0) {
    throw Object.assign(
      new ApiError('Patch must include at least one field', 400),
      { errorCode: 'INVALID_INPUT' },
    );
  }
  const clean: CategoryPatchInput = {};
  if (patch.nameEn !== undefined) {
    const v = patch.nameEn.trim();
    if (v.length === 0) {
      throw Object.assign(new ApiError('nameEn cannot be empty', 400), {
        errorCode: 'INVALID_INPUT',
      });
    }
    if (v.length > 200) {
      throw Object.assign(
        new ApiError('nameEn must be 200 characters or fewer', 400),
        { errorCode: 'INVALID_INPUT' },
      );
    }
    clean.nameEn = v;
  }
  if (patch.nameEs !== undefined) {
    const v = patch.nameEs.trim();
    if (v.length === 0) {
      throw Object.assign(new ApiError('nameEs cannot be empty', 400), {
        errorCode: 'INVALID_INPUT',
      });
    }
    if (v.length > 200) {
      throw Object.assign(
        new ApiError('nameEs must be 200 characters or fewer', 400),
        { errorCode: 'INVALID_INPUT' },
      );
    }
    clean.nameEs = v;
  }
  if (patch.categoryType !== undefined) {
    const v = patch.categoryType.trim();
    if (v.length === 0) {
      throw Object.assign(new ApiError('categoryType cannot be empty', 400), {
        errorCode: 'INVALID_INPUT',
      });
    }
    clean.categoryType = v;
  }
  if (patch.categoryIcon !== undefined) {
    const v = patch.categoryIcon.trim();
    if (v.length === 0) {
      throw Object.assign(new ApiError('categoryIcon cannot be empty', 400), {
        errorCode: 'INVALID_INPUT',
      });
    }
    clean.categoryIcon = v;
  }

  const existing = await db
    .update(categories)
    .set(patch)
    .where(eq(categories.id, id))
    .returning({ id: categories.id });

  if (existing.length === 0) {
    throw Object.assign(new ApiError('Category not found', 404), {
      errorCode: 'CATEGORY_NOT_FOUND',
    });
  }

  const [row] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, id))
    .limit(1);
  return publicCategory(row!);
}

export async function deleteCategory(id: string): Promise<void> {
  const [existing] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.id, id))
    .limit(1);
  if (!existing) {
    throw Object.assign(new ApiError('Category not found', 404), {
      errorCode: 'CATEGORY_NOT_FOUND',
    });
  }
  await db.delete(categories).where(eq(categories.id, id));
}
