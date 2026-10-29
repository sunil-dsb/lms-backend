import ApiError from '../../shared/utils/ApiError.ts';
import {
  SQL,
  and,
  desc,
  asc,
  eq,
  ilike,
  or,
  count,
  isNull,
  isNotNull,
  sql,
} from 'drizzle-orm';
import {
  formatPaginatedResult,
  type PaginatedResult,
} from '../../shared/utils/pagination.ts';
import { db } from '../../db/client.ts';
import {
  trainingCourses,
  trainingChapters,
  quiz,
  type Quiz,
  type TrainingCourse,
  type TrainingChapter,
  type CreateCourseInput,
  type UpdateCourseInput,
  type TrainingCourseStatus,
} from '../../db/index.ts';
import { logger } from '../../config/logger.ts';

export interface ChapterQuizSummary {
  id: string;
  attached?: boolean;
  questions?: unknown;
  minCorrectAnswers?: number | null;
  quizType?: string;
  nameEn?: string;
  nameEs?: string;
}

export interface CourseWithChapters extends TrainingCourse {
  chapters: (TrainingChapter & { quiz?: ChapterQuizSummary | Quiz | null })[];
}

export interface CourseListItem extends TrainingCourse {
  chapterCount: number;
  assignedCount: number;
  quizCount?: number;
  hasQuiz?: boolean;
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
        assignUsers: input.assignUsers || [],
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

    let finalChapters: CourseWithChapters['chapters'] = insertedChapters;
    if (insertedChapters.length > 0) {
      const chapterRows = await tx
        .select({
          chapter: trainingChapters,
          chapterQuiz: quiz,
        })
        .from(trainingChapters)
        .leftJoin(quiz, eq(trainingChapters.quizId, quiz.id))
        .where(eq(trainingChapters.courseId, insertedCourse.id))
        .orderBy(asc(trainingChapters.number));

      finalChapters = chapterRows.map((r) => ({
        ...r.chapter,
        quiz: r.chapterQuiz
          ? {
              id: r.chapterQuiz.id,
              attached: true,
              questions: r.chapterQuiz.questions,
              minCorrectAnswers: r.chapter.minCorrectAnswers ?? null,
            }
          : null,
      }));
    }

    logger.info(
      `Course "${insertedCourse.titleEn}" (${insertedCourse.id}) created by ${actor.userId || 'system'} with ${insertedChapters.length} chapters`,
    );

    return {
      ...insertedCourse,
      chapters: finalChapters,
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

  const chapterRows = await db
    .select({
      chapter: trainingChapters,
      chapterQuiz: quiz,
    })
    .from(trainingChapters)
    .leftJoin(quiz, eq(trainingChapters.quizId, quiz.id))
    .where(eq(trainingChapters.courseId, id))
    .orderBy(asc(trainingChapters.number));

  const chapters = chapterRows.map((r) => ({
    ...r.chapter,
    quiz: r.chapterQuiz
      ? {
          id: r.chapterQuiz.id,
          attached: true,
          questions: r.chapterQuiz.questions,
          minCorrectAnswers: r.chapter.minCorrectAnswers ?? null,
        }
      : null,
  }));

  return {
    ...course,
    chapters,
  };
}

/**
 * Lists courses with optional text search, status filtering, assignment filtering, and pagination.
 */
export async function listCourses(params: {
  search?: string | undefined;
  status?: TrainingCourseStatus | undefined;
  assignment?: 'all' | 'assigned' | 'unassigned' | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}): Promise<PaginatedResult<CourseListItem>> {
  const { search, status, assignment, page = 1, limit = 20 } = params;
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [];

  if (status) {
    conditions.push(eq(trainingCourses.status, status));
  }

  if (assignment === 'assigned') {
    conditions.push(
      and(
        isNotNull(trainingCourses.assignUsers),
        sql`cardinality(${trainingCourses.assignUsers}) > 0`,
      )!,
    );
  } else if (assignment === 'unassigned') {
    conditions.push(
      or(
        isNull(trainingCourses.assignUsers),
        sql`cardinality(${trainingCourses.assignUsers}) = 0`,
      )!,
    );
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

  // Rows with chapter count & quiz count
  const rows = await db
    .select({
      course: trainingCourses,
      chapterCount: count(trainingChapters.id),
      quizCount: count(trainingChapters.quizId),
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

  const items: CourseListItem[] = rows.map((r) => {
    const users = Array.isArray(r.course.assignUsers)
      ? r.course.assignUsers
      : [];
    return {
      ...r.course,
      chapterCount: Number(r.chapterCount),
      quizCount: Number(r.quizCount),
      hasQuiz: Number(r.quizCount) > 0,
      assignedCount: users.length,
    };
  });

  // Bucket counts for the Courses tab filter chips (all / assigned /
  // unassigned / archived) — one filtered-count query so the chips can stay
  // right while the page itself only fetches the visible bucket's rows.
  const [countsRow] = await db
    .select({
      all: sql<number>`count(*) filter (where ${trainingCourses.status} <> 'archived')`,
      assigned: sql<number>`count(*) filter (where ${trainingCourses.status} <> 'archived' and ${trainingCourses.assignUsers} is not null and cardinality(${trainingCourses.assignUsers}) > 0)`,
      unassigned: sql<number>`count(*) filter (where ${trainingCourses.status} <> 'archived' and (${trainingCourses.assignUsers} is null or cardinality(${trainingCourses.assignUsers}) = 0))`,
      archived: sql<number>`count(*) filter (where ${trainingCourses.status} = 'archived')`,
    })
    .from(trainingCourses);
  const counts = {
    all: Number(countsRow?.all ?? 0),
    assigned: Number(countsRow?.assigned ?? 0),
    unassigned: Number(countsRow?.unassigned ?? 0),
    archived: Number(countsRow?.archived ?? 0),
  };

  return {
    ...formatPaginatedResult(items, Number(total), page, limit),
    counts,
  } as PaginatedResult<CourseListItem> & { counts: typeof counts };
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
    if (input.assignUsers !== undefined)
      updateValues.assignUsers = input.assignUsers;

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

    const currentChapterRows = await tx
      .select({
        chapter: trainingChapters,
        chapterQuiz: quiz,
      })
      .from(trainingChapters)
      .leftJoin(quiz, eq(trainingChapters.quizId, quiz.id))
      .where(eq(trainingChapters.courseId, id))
      .orderBy(asc(trainingChapters.number));

    const currentChapters = currentChapterRows.map((r) => ({
      ...r.chapter,
      quiz: r.chapterQuiz
        ? {
            id: r.chapterQuiz.id,
            attached: true,
            questions: r.chapterQuiz.questions,
            minCorrectAnswers: r.chapter.minCorrectAnswers ?? null,
          }
        : null,
    }));

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
