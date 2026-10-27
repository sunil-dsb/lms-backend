import ApiError from '../../shared/utils/ApiError.ts';
import { SQL, and, desc, asc, eq, ilike, or, count } from 'drizzle-orm';
import {
  formatPaginatedResult,
  type PaginatedResult,
} from '../../shared/utils/pagination.ts';
import { db } from '../../db/client.ts';
import {
  trainingCourses,
  trainingChapters,
  type TrainingCourse,
  type TrainingChapter,
  type CreateCourseInput,
  type UpdateCourseInput,
  type TrainingCourseStatus,
} from '../../db/index.ts';
import { logger } from '../../config/logger.ts';

export interface CourseWithChapters extends TrainingCourse {
  chapters: TrainingChapter[];
}

export interface CourseListItem extends TrainingCourse {
  chapterCount: number;
}

/**
 * Creates a course and optionally its initial chapters in a single transaction.
 */
export async function createCourse(
  input: CreateCourseInput,
  actor: { userId?: string | undefined },
): Promise<CourseWithChapters> {
  return await db.transaction(async (tx) => {
    const [insertedCourse] = await tx
      .insert(trainingCourses)
      .values({
        titleEn: input.titleEn,
        titleEs: input.titleEs,
        purposeEn: input.purposeEn,
        purposeEs: input.purposeEs,
        status: 'published',
        createdBy: actor.userId || null,
      })
      .returning();

    if (!insertedCourse) {
      throw new ApiError('Failed to create training course', 500);
    }

    let insertedChapters: TrainingChapter[] = [];
    if (input.chapters && input.chapters.length > 0) {
      const chapterValues = input.chapters.map((ch, idx) => ({
        ...(ch.id ? { id: ch.id } : {}),
        courseId: insertedCourse.id,
        number: ch.number || idx + 1,
        titleEn: ch.titleEn,
        titleEs: ch.titleEs,
        subtitleEn: ch.subtitleEn || '',
        subtitleEs: ch.subtitleEs || '',
        blocks: ch.blocks || [],
        procedureId: ch.procedureId || null,
        quizId: ch.quizId || null,
        minCorrectAnswers: ch.minCorrectAnswers ?? null,
      }));

      insertedChapters = await tx
        .insert(trainingChapters)
        .values(chapterValues)
        .returning();
    }

    logger.info(
      `Course "${insertedCourse.titleEn}" (${insertedCourse.id}) created by ${actor.userId || 'system'} with ${insertedChapters.length} chapters`,
    );

    return {
      ...insertedCourse,
      chapters: insertedChapters.sort((a, b) => a.number - b.number),
    };
  });
}

/**
 * Retrieves a single course by its UUID with all attached chapters ordered by chapter number.
 */
export async function getCourseById(id: string): Promise<CourseWithChapters> {
  const [course] = await db
    .select()
    .from(trainingCourses)
    .where(eq(trainingCourses.id, id))
    .limit(1);

  if (!course) {
    throw new ApiError('Training course not found', 404, true, '', {
      code: 'COURSE_NOT_FOUND',
    });
  }

  const chapters = await db
    .select()
    .from(trainingChapters)
    .where(eq(trainingChapters.courseId, id))
    .orderBy(asc(trainingChapters.number));

  return {
    ...course,
    chapters,
  };
}

/**
 * Lists courses with optional text search, status filtering, and pagination.
 */
export async function listCourses(params: {
  search?: string | undefined;
  status?: TrainingCourseStatus | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}): Promise<PaginatedResult<CourseListItem>> {
  const { search, status, page = 1, limit = 20 } = params;
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [];

  if (status) {
    conditions.push(eq(trainingCourses.status, status));
  }

  if (search && search.trim().length > 0) {
    const term = `%${search.trim()}%`;
    conditions.push(
      or(
        ilike(trainingCourses.titleEn, term),
        ilike(trainingCourses.titleEs, term),
        ilike(trainingCourses.purposeEn, term),
        ilike(trainingCourses.purposeEs, term),
      )!,
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Total count
  const countResult = await db
    .select({ total: count() })
    .from(trainingCourses)
    .where(whereClause);
  const total = countResult[0]?.total ?? 0;

  // Rows with chapter count
  const rows = await db
    .select({
      course: trainingCourses,
      chapterCount: count(trainingChapters.id),
    })
    .from(trainingCourses)
    .leftJoin(
      trainingChapters,
      eq(trainingCourses.id, trainingChapters.courseId),
    )
    .where(whereClause)
    .groupBy(trainingCourses.id)
    .orderBy(desc(trainingCourses.updatedAt))
    .limit(limit)
    .offset(offset);

  const items: CourseListItem[] = rows.map((r) => ({
    ...r.course,
    chapterCount: Number(r.chapterCount),
  }));

  return formatPaginatedResult(items, Number(total), page, limit);
}

/**
 * Updates course metadata and optionally replaces the chapter set in a single transaction.
 */
export async function updateCourse(
  id: string,
  input: UpdateCourseInput,
  actor: { userId?: string | undefined },
): Promise<CourseWithChapters> {
  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(trainingCourses)
      .where(eq(trainingCourses.id, id))
      .limit(1);

    if (!existing) {
      throw new ApiError('Training course not found', 404, true, '', {
        code: 'COURSE_NOT_FOUND',
      });
    }

    const updateValues: Partial<typeof trainingCourses.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (input.titleEn !== undefined) updateValues.titleEn = input.titleEn;
    if (input.titleEs !== undefined) updateValues.titleEs = input.titleEs;
    if (input.purposeEn !== undefined) updateValues.purposeEn = input.purposeEn;
    if (input.purposeEs !== undefined) updateValues.purposeEs = input.purposeEs;

    const [updatedCourse] = await tx
      .update(trainingCourses)
      .set(updateValues)
      .where(eq(trainingCourses.id, id))
      .returning();

    if (!updatedCourse) {
      throw new ApiError('Failed to update training course', 500);
    }

    // If chapters are supplied, sync them (delete and reinsert to keep ordering consistent)
    if (input.chapters !== undefined) {
      await tx
        .delete(trainingChapters)
        .where(eq(trainingChapters.courseId, id));

      if (input.chapters.length > 0) {
        const chapterValues = input.chapters.map((ch, idx) => ({
          ...(ch.id ? { id: ch.id } : {}),
          courseId: id,
          number: ch.number || idx + 1,
          titleEn: ch.titleEn,
          titleEs: ch.titleEs,
          subtitleEn: ch.subtitleEn || '',
          subtitleEs: ch.subtitleEs || '',
          blocks: ch.blocks || [],
          procedureId: ch.procedureId || null,
          quizId: ch.quizId || null,
          minCorrectAnswers: ch.minCorrectAnswers ?? null,
          updatedAt: new Date(),
        }));

        await tx.insert(trainingChapters).values(chapterValues);
      }
    }

    const currentChapters = await tx
      .select()
      .from(trainingChapters)
      .where(eq(trainingChapters.courseId, id))
      .orderBy(asc(trainingChapters.number));

    logger.info(
      `Course "${updatedCourse.titleEn}" (${id}) updated by ${actor.userId || 'system'}`,
    );

    return {
      ...updatedCourse,
      chapters: currentChapters,
    };
  });
}

/**
 * Sets course status to 'archived'.
 */
export async function archiveCourse(id: string): Promise<TrainingCourse> {
  const [course] = await db
    .update(trainingCourses)
    .set({
      status: 'archived',
      updatedAt: new Date(),
    })
    .where(eq(trainingCourses.id, id))
    .returning();

  if (!course) {
    throw new ApiError('Training course not found', 404, true, '', {
      code: 'COURSE_NOT_FOUND',
    });
  }

  logger.info(`Course "${course.titleEn}" (${id}) archived`);
  return course;
}

/**
 * Restores an archived course to 'published'.
 */
export async function unarchiveCourse(id: string): Promise<TrainingCourse> {
  const [course] = await db
    .update(trainingCourses)
    .set({
      status: 'published',
      updatedAt: new Date(),
    })
    .where(eq(trainingCourses.id, id))
    .returning();

  if (!course) {
    throw new ApiError('Training course not found', 404, true, '', {
      code: 'COURSE_NOT_FOUND',
    });
  }

  logger.info(`Course "${course.titleEn}" (${id}) unarchived/restored`);
  return course;
}

/**
 * Hard delete a course and cascade delete all its chapters.
 */
export async function deleteCourse(id: string): Promise<void> {
  const result = await db
    .delete(trainingCourses)
    .where(eq(trainingCourses.id, id))
    .returning({ id: trainingCourses.id });

  if (result.length === 0) {
    throw new ApiError('Training course not found', 404, true, '', {
      code: 'COURSE_NOT_FOUND',
    });
  }

  logger.info(`Course (${id}) and all chapters deleted`);
}
