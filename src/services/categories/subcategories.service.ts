import ApiError from '../../shared/utils/ApiError.ts';
import crypto from 'node:crypto';
import { eq, asc, count, ilike, or, and, SQL } from 'drizzle-orm';
import {
  formatPaginatedResult,
  type PaginatedResult,
} from '../../shared/utils/pagination.ts';
import { db } from '../../db/client.ts';
import { categories } from '../../db/categories.schema.ts';
import { subcategories } from '../../db/subcategories.schema.ts';

export interface PublicSubcategory {
  id: string;
  categoryId: string;
  nameEn: string;
  nameEs: string;
  subcategoryIcon: string;
}

export function publicSubcategory(
  s: Readonly<typeof subcategories.$inferSelect>,
): PublicSubcategory {
  return {
    id: s.id,
    categoryId: s.categoryId,
    nameEn: s.nameEn,
    nameEs: s.nameEs,
    subcategoryIcon: s.subcategoryIcon,
  };
}

export async function listSubcategories(
  categoryId?: string,
  page: number = 1,
  limit: number = 10,
  search?: string,
): Promise<PaginatedResult<PublicSubcategory>> {
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [];
  if (categoryId) {
    conditions.push(eq(subcategories.categoryId, categoryId));
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
    .select()
    .from(subcategories)
    .where(whereClause)
    .orderBy(asc(subcategories.createdAt))
    .limit(limit)
    .offset(offset);

  const [countRes] = await db
    .select({ total: count() })
    .from(subcategories)
    .where(whereClause);

  return formatPaginatedResult(
    rows.map(publicSubcategory),
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
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1);
  if (!cat) {
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
    subcategoryIcon: input.subcategoryIcon,
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

export async function getSubcategoryById(
  id: string,
): Promise<PublicSubcategory> {
  const [row] = await db
    .select()
    .from(subcategories)
    .where(eq(subcategories.id, id))
    .limit(1);
  if (!row) {
    throw Object.assign(new ApiError('Subcategory not found', 404), {
      errorCode: 'SUBCATEGORY_NOT_FOUND',
    });
  }
  return publicSubcategory(row);
}
