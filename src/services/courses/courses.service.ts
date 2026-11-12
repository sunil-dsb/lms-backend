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
  inArray,
  sql,
} from 'drizzle-orm';
import {
  formatPaginatedResult,
  type PaginatedResult,
} from '../../shared/utils/pagination.ts';
import { db } from '../../db/client.ts';
import {
  employees,
  trainingCourseAssignments,
  trainingCourses,
  trainingChapters,
  quiz,
  type AuditChanges,
  type ChapterInput,
  type Quiz,
  type TrainingCourse,
  type TrainingChapter,
  type CreateCourseInput,
  type UpdateCourseInput,
  type TrainingCourseStatus,
} from '../../db/index.ts';
import { logger } from '../../config/logger.ts';
import {
  recordAudit,
  diffChanges,
  summarizeBlocks,
  chapterContentSnapshot,
  isSameValue,
  type AuditActor,
} from '../audit/audit.service.ts';

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
 * Synchronizes course assignments for all employees belonging to the given stations.
 * Automatically marks the assignment as required, sets a 7-day due date, and assigns the first chapter.
 */
export async function syncCourseStationAssignments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  courseId: string,
  stationIds: string[],
): Promise<void> {
  if (!stationIds || stationIds.length === 0) return;

  const [firstChapter] = await tx
    .select({ id: trainingChapters.id })
    .from(trainingChapters)
    .where(eq(trainingChapters.courseId, courseId))
    .orderBy(asc(trainingChapters.number))
    .limit(1);

  if (!firstChapter) return;

  const stationEmployees = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(
      and(
        inArray(employees.status, ['active', 'pending']),
        sql`${employees.stationIds} && ARRAY[${sql.join(
          stationIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`,
      ),
    );

  if (stationEmployees.length === 0) return;

  const defaultDue = new Date();
  defaultDue.setDate(defaultDue.getDate() + 7);
  const dueDateStr = defaultDue.toISOString().slice(0, 10);

  const empIds: string[] = stationEmployees.map((e: { id: string }) => e.id);

  for (const empId of empIds) {
    await tx
      .insert(trainingCourseAssignments)
      .values({
        courseId,
        employeeId: empId,
        dueDate: dueDateStr,
        isRequired: true,
        currentChapterId: firstChapter.id,
      })
      .onConflictDoNothing({
        target: [
          trainingCourseAssignments.courseId,
          trainingCourseAssignments.employeeId,
        ],
      });
  }

  const [course] = await tx
    .select({ assignUsers: trainingCourses.assignUsers })
    .from(trainingCourses)
    .where(eq(trainingCourses.id, courseId))
    .limit(1);

  const currentUsers = course?.assignUsers || [];
  const updatedUsers = Array.from(new Set([...currentUsers, ...empIds]));
  await tx
    .update(trainingCourses)
    .set({
      assignUsers: updatedUsers,
      updatedAt: new Date(),
    })
    .where(eq(trainingCourses.id, courseId));
}

/**
 * Creates a course and optionally its initial chapters in a single transaction.
 */
export async function createCourse(
  input: CreateCourseInput,
  actor: AuditActor,
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
        stationIds: input.stationIds || [],
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

    if (
      insertedChapters.length > 0 &&
      input.stationIds &&
      input.stationIds.length > 0
    ) {
      await syncCourseStationAssignments(
        tx,
        insertedCourse.id,
        input.stationIds,
      );
    }

    logger.info(
      `Course "${insertedCourse.titleEn}" (${insertedCourse.id}) created by ${actor.userId || 'system'} with ${insertedChapters.length} chapters`,
    );

    await recordAudit({
      actor,
      executor: tx,
      itemType: 'course',
      itemId: insertedCourse.id,
      itemName: insertedCourse.titleEn,
      action: 'create',
      changes: {
        title: { from: null, to: insertedCourse.titleEn },
        status: { from: null, to: insertedCourse.status },
      },
    });

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
  employeeCourseIds?: string[] | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}): Promise<PaginatedResult<CourseListItem>> {
  const {
    search,
    status,
    assignment,
    employeeCourseIds,
    page = 1,
    limit = 20,
  } = params;
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [];

  if (status) {
    conditions.push(eq(trainingCourses.status, status));
  }

  if (employeeCourseIds !== undefined) {
    conditions.push(
      employeeCourseIds.length > 0
        ? inArray(trainingCourses.id, employeeCourseIds)
        : sql`false`,
    );
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
  actor: AuditActor,
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
    if (input.stationIds !== undefined)
      updateValues.stationIds = input.stationIds;

    const [updatedCourse] = await tx
      .update(trainingCourses)
      .set(updateValues)
      .where(eq(trainingCourses.id, id))
      .returning();

    if (!updatedCourse) {
      throw new ApiError('Failed to update training course', 500);
    }

    // If chapters are supplied, sync them (delete and reinsert to keep ordering consistent).
    // Snapshot the old set first: the delete destroys the only "before"
    // state the audit diff could compare against (block edits live here).
    let chapterChanges: AuditChanges = {};
    if (input.chapters !== undefined) {
      const beforeChapters = await tx
        .select({
          id: trainingChapters.id,
          number: trainingChapters.number,
          titleEn: trainingChapters.titleEn,
          titleEs: trainingChapters.titleEs,
          subtitleEn: trainingChapters.subtitleEn,
          subtitleEs: trainingChapters.subtitleEs,
          blocks: trainingChapters.blocks,
          procedureId: trainingChapters.procedureId,
          quizId: trainingChapters.quizId,
          minCorrectAnswers: trainingChapters.minCorrectAnswers,
        })
        .from(trainingChapters)
        .where(eq(trainingChapters.courseId, id));

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

        const [firstCh] = await tx
          .select({ id: trainingChapters.id })
          .from(trainingChapters)
          .where(eq(trainingChapters.courseId, id))
          .orderBy(asc(trainingChapters.number))
          .limit(1);

        if (firstCh) {
          await tx
            .update(trainingCourseAssignments)
            .set({ currentChapterId: firstCh.id })
            .where(
              and(
                eq(trainingCourseAssignments.courseId, id),
                isNull(trainingCourseAssignments.courseCompletedAt),
                isNull(trainingCourseAssignments.currentChapterId),
              ),
            );
        }
      }

      chapterChanges = diffChapterSet(beforeChapters, input.chapters);
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

    const effectiveStationIds =
      input.stationIds !== undefined ? input.stationIds : existing.stationIds;
    if (effectiveStationIds && effectiveStationIds.length > 0) {
      await syncCourseStationAssignments(tx, id, effectiveStationIds);
    }

    logger.info(
      `Course "${updatedCourse.titleEn}" (${id}) updated by ${actor.userId || 'system'}`,
    );

    const courseChanges =
      diffChanges(
        existing as unknown as Record<string, unknown>,
        updatedCourse as unknown as Record<string, unknown>,
        [
          'titleEn',
          'titleEs',
          'purposeEn',
          'purposeEs',
          'status',
          'assignUsers',
          'stationIds',
        ],
      ) ?? {};
    const changes: AuditChanges = { ...courseChanges, ...chapterChanges };

    // No-op saves (nothing moved in the diff) leave no trace: an "update"
    // row with no field-level changes is noise in the log.
    if (Object.keys(changes).length > 0) {
      await recordAudit({
        actor,
        executor: tx,
        itemType: 'course',
        itemId: id,
        itemName: updatedCourse.titleEn,
        action: 'update',
        changes,
      });
    }

    return {
      ...updatedCourse,
      chapters: currentChapters,
    };
  });
}

/**
 * Sets course status to 'archived'.
 */
export async function archiveCourse(
  id: string,
  actor: AuditActor,
): Promise<TrainingCourse> {
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
  await recordAudit({
    actor,
    itemType: 'course',
    itemId: id,
    itemName: course.titleEn,
    action: 'archive',
    changes: { status: { from: 'published', to: 'archived' } },
  });
  return course;
}

/**
 * Restores an archived course to 'published'.
 */
export async function unarchiveCourse(
  id: string,
  actor: AuditActor,
): Promise<TrainingCourse> {
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
  await recordAudit({
    actor,
    itemType: 'course',
    itemId: id,
    itemName: course.titleEn,
    action: 'unarchive',
    changes: { status: { from: 'archived', to: 'published' } },
  });
  return course;
}

/**
 * Hard delete a course and cascade delete all its chapters.
 */
export async function deleteCourse(
  id: string,
  actor: AuditActor,
): Promise<void> {
  // Capture the title first — after the DELETE the label is gone, and the
  // audit entry must still read sensibly.
  const [existing] = await db
    .select({ titleEn: trainingCourses.titleEn })
    .from(trainingCourses)
    .where(eq(trainingCourses.id, id))
    .limit(1);

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
  await recordAudit({
    actor,
    itemType: 'course',
    itemId: id,
    itemName: existing?.titleEn ?? null,
    action: 'delete',
    changes: { title: { from: existing?.titleEn ?? null, to: null } },
  });
}

/** The chapter snapshot updateCourse takes before it deletes the old set. */
type BeforeChapter = {
  id: string;
  number: number;
  titleEn: string;
  titleEs: string;
  subtitleEn: string;
  subtitleEs: string;
  blocks: unknown[];
  procedureId: string | null;
  quizId: string | null;
  minCorrectAnswers: number | null;
};

/**
 * Field-level diff of a chapter-set replacement (updateCourse deletes and
 * reinserts every chapter, so nothing downstream can see what moved — block
 * edits used to audit as "No field-level changes recorded").
 *
 * Old→new pairs by client id first (chapters keep their id across the
 * delete+reinsert), then by chapter number for id-less rows, so a client
 * that regenerates ids still gets a positional diff instead of "everything
 * deleted, everything added". Blocks are stored as one short label per block:
 * the raw JSON is the whole document body, far too big for an audit row.
 * Keys look like `Chapter “Intro” · blocks`; the UI splits on ` · ` and
 * localizes the tail.
 */
function diffChapterSet(
  before: BeforeChapter[],
  after: ChapterInput[],
): AuditChanges {
  const changes: AuditChanges = {};

  const pairs: Array<{ b: BeforeChapter; a: ChapterInput }> = [];
  const usedBefore = new Set<string>();
  const usedAfter = new Set<ChapterInput>();

  const beforeById = new Map(before.map((b) => [b.id, b]));
  for (const a of after) {
    const b = a.id ? beforeById.get(a.id) : undefined;
    if (b && !usedBefore.has(b.id)) {
      pairs.push({ b, a });
      usedBefore.add(b.id);
      usedAfter.add(a);
    }
  }
  for (const b of before) {
    if (usedBefore.has(b.id)) continue;
    const a = after.find((c) => !usedAfter.has(c) && c.number === b.number);
    if (a) {
      pairs.push({ b, a });
      usedBefore.add(b.id);
      usedAfter.add(a);
    }
  }

  // One key per chapter; chapter titles can repeat, so fall back to
  // (#2), (#3)… rather than silently dropping a change.
  const chapterKey = (title: string, field: string): string => {
    const base = `Chapter “${title.trim() || 'Untitled'}” · ${field}`;
    let key = base;
    let n = 2;
    while (key in changes) key = `${base} (#${n++})`;
    return key;
  };
  const put = (
    title: string,
    field: string,
    from: unknown,
    to: unknown,
  ): void => {
    if (isSameValue(from, to)) return;
    changes[chapterKey(title, field)] = { from, to };
  };

  for (const { b, a } of pairs) {
    const title = a.titleEn || b.titleEn;
    put(title, 'titleEn', b.titleEn, a.titleEn);
    put(title, 'titleEs', b.titleEs, a.titleEs);
    put(title, 'subtitleEn', b.subtitleEn, a.subtitleEn);
    put(title, 'subtitleEs', b.subtitleEs, a.subtitleEs);
    put(title, 'position', b.number, a.number);
    // Compare and store the labels: the label list is stable across client
    // re-serialization (key order) and is exactly what the UI can render.
    put(
      title,
      'blocks',
      summarizeBlocks(b.blocks),
      summarizeBlocks(a.blocks || []),
    );
    // The chapter row also carries the procedure link and the quiz wiring —
    // without these a course save that only attaches/detaches a quiz audited
    // as an update with no field-level changes.
    put(title, 'procedureId', b.procedureId, a.procedureId);
    put(title, 'quizId', b.quizId, a.quizId);
    put(title, 'minCorrectAnswers', b.minCorrectAnswers, a.minCorrectAnswers);
  }

  for (const b of before) {
    if (usedBefore.has(b.id)) continue;
    changes[chapterKey(b.titleEn, 'removed')] = {
      from: chapterContentSnapshot(b.titleEn, b.blocks),
      to: null,
    };
  }
  for (const a of after) {
    if (usedAfter.has(a)) continue;
    changes[chapterKey(a.titleEn, 'added')] = {
      from: null,
      to: chapterContentSnapshot(a.titleEn, a.blocks || []),
    };
  }

  return changes;
}
