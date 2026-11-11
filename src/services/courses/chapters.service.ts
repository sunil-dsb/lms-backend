import ApiError from '../../shared/utils/ApiError.ts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  trainingCourses,
  trainingChapters,
  quiz,
  type AuditChanges,
  type TrainingChapter,
  type CreateChapterInput,
  type UpdateChapterInput,
  type ReorderChaptersInput,
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

export interface ChapterWithQuiz extends TrainingChapter {
  quiz: {
    id: string;
    attached: boolean;
    questions: unknown;
    minCorrectAnswers: number | null;
  } | null;
}

/**
 * Lists all chapters, optionally filtered by course ID, ordered by chapter number.
 */
export async function listChapters(
  courseId?: string,
): Promise<ChapterWithQuiz[]> {
  if (courseId) {
    const [course] = await db
      .select({ id: trainingCourses.id })
      .from(trainingCourses)
      .where(eq(trainingCourses.id, courseId))
      .limit(1);

    if (!course) {
      throw new ApiError('Training course not found', 404, true, '', {
        code: 'COURSE_NOT_FOUND',
      });
    }
  }

  const query = db
    .select({
      chapter: trainingChapters,
      chapterQuiz: quiz,
    })
    .from(trainingChapters)
    .leftJoin(quiz, eq(trainingChapters.quizId, quiz.id));

  const rows = courseId
    ? await query
        .where(eq(trainingChapters.courseId, courseId))
        .orderBy(asc(trainingChapters.number))
    : await query.orderBy(asc(trainingChapters.number));

  return rows.map((r) => ({
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

export const listChaptersByCourse = listChapters;

/**
 * Retrieves a single chapter by chapter ID and optional course ID.
 */
export async function getChapterById(
  chapterIdOrNumber: string,
  courseId?: string,
): Promise<ChapterWithQuiz> {
  const isNumber = /^\d+$/.test(chapterIdOrNumber);
  const conditions = [];
  if (isNumber && courseId) {
    conditions.push(
      eq(trainingChapters.courseId, courseId),
      eq(trainingChapters.number, parseInt(chapterIdOrNumber, 10)),
    );
  } else {
    conditions.push(eq(trainingChapters.id, chapterIdOrNumber));
    if (courseId) {
      conditions.push(eq(trainingChapters.courseId, courseId));
    }
  }

  const [row] = await db
    .select({
      chapter: trainingChapters,
      chapterQuiz: quiz,
    })
    .from(trainingChapters)
    .leftJoin(quiz, eq(trainingChapters.quizId, quiz.id))
    .where(and(...conditions))
    .limit(1);

  if (!row) {
    throw new ApiError('Chapter not found', 404, true, '', {
      code: 'CHAPTER_NOT_FOUND',
    });
  }

  return {
    ...row.chapter,
    quiz: row.chapterQuiz
      ? {
          id: row.chapterQuiz.id,
          attached: true,
          questions: row.chapterQuiz.questions,
          minCorrectAnswers: row.chapter.minCorrectAnswers ?? null,
        }
      : null,
  };
}

/**
 * Creates a new chapter within a course.
 * Automatically manages quiz creation if inline quiz questions are provided.
 */
export async function createChapter(
  courseIdOrInput: string | (CreateChapterInput & { courseId: string }),
  inputOrActor?: CreateChapterInput | AuditActor,
  actorParam?: AuditActor,
): Promise<ChapterWithQuiz> {
  const courseId =
    typeof courseIdOrInput === 'string'
      ? courseIdOrInput
      : courseIdOrInput.courseId;

  const input: CreateChapterInput =
    typeof courseIdOrInput === 'string'
      ? (inputOrActor as CreateChapterInput)
      : courseIdOrInput;

  const actor: AuditActor =
    typeof courseIdOrInput === 'string'
      ? actorParam || {}
      : (inputOrActor as AuditActor) || {};

  if (!courseId) {
    throw new ApiError('Course ID is required', 400, true, '', {
      code: 'INVALID_INPUT',
    });
  }

  return await db.transaction(async (tx) => {
    const [course] = await tx
      .select({ id: trainingCourses.id, titleEn: trainingCourses.titleEn })
      .from(trainingCourses)
      .where(eq(trainingCourses.id, courseId))
      .limit(1);

    if (!course) {
      throw new ApiError('Training course not found', 404, true, '', {
        code: 'COURSE_NOT_FOUND',
      });
    }

    // Determine chapter number
    let chapterNumber = input.number;
    if (!chapterNumber) {
      const [maxRow] = await tx
        .select({
          maxNum: sql<number>`coalesce(max(${trainingChapters.number}), 0)`,
        })
        .from(trainingChapters)
        .where(eq(trainingChapters.courseId, courseId));

      chapterNumber = Number(maxRow?.maxNum ?? 0) + 1;
    }

    // Handle quiz: create a new quiz record if inline questions provided
    let effectiveQuizId = input.quizId || null;
    let quizRecord: typeof quiz.$inferSelect | null = null;

    if (
      input.quiz &&
      Array.isArray(input.quiz.questions) &&
      input.quiz.questions.length > 0
    ) {
      const [newQuiz] = await tx
        .insert(quiz)
        .values({
          nameEn: input.titleEn,
          nameEs: input.titleEs,
          quizType: 'course',
          questions: input.quiz.questions,
          createdBy: actor.userId || null,
        })
        .returning();

      if (newQuiz) {
        effectiveQuizId = newQuiz.id;
        quizRecord = newQuiz;
      }
    } else if (effectiveQuizId) {
      const [existingQuiz] = await tx
        .select()
        .from(quiz)
        .where(eq(quiz.id, effectiveQuizId))
        .limit(1);
      quizRecord = existingQuiz || null;
    }

    const minCorrect =
      input.quiz?.minCorrectAnswers ?? input.minCorrectAnswers ?? null;

    const [insertedChapter] = await tx
      .insert(trainingChapters)
      .values({
        courseId,
        number: chapterNumber,
        titleEn: input.titleEn,
        titleEs: input.titleEs,
        subtitleEn: input.subtitleEn || '',
        subtitleEs: input.subtitleEs || '',
        blocks: input.blocks || [],
        procedureId: input.procedureId || null,
        quizId: effectiveQuizId,
        minCorrectAnswers: minCorrect,
      })
      .returning();

    if (!insertedChapter) {
      throw new ApiError('Failed to create chapter', 500);
    }

    // Update parent course's updatedAt
    await tx
      .update(trainingCourses)
      .set({ updatedAt: new Date() })
      .where(eq(trainingCourses.id, courseId));

    logger.info(
      `Chapter "${insertedChapter.titleEn}" (#${insertedChapter.number}) created in course "${course.titleEn}" (${courseId}) by ${actor.userId || 'system'}`,
    );

    const createdBlocks = summarizeBlocks(insertedChapter.blocks);
    await recordAudit({
      actor,
      executor: tx,
      itemType: 'chapter',
      itemId: insertedChapter.id,
      itemName: insertedChapter.titleEn,
      action: 'create',
      changes: {
        title: { from: null, to: insertedChapter.titleEn },
        ...(createdBlocks.length > 0
          ? { blocks: { from: null, to: createdBlocks } }
          : {}),
      },
    });

    return {
      ...insertedChapter,
      quiz: quizRecord
        ? {
            id: quizRecord.id,
            attached: true,
            questions: quizRecord.questions,
            minCorrectAnswers: insertedChapter.minCorrectAnswers,
          }
        : null,
    };
  });
}

/**
 * Updates an existing chapter.
 * Handles inline quiz updates or new quiz attachment.
 */
export async function updateChapter(
  chapterId: string,
  input: UpdateChapterInput,
  actor: AuditActor,
  courseId?: string,
): Promise<ChapterWithQuiz> {
  return await db.transaction(async (tx) => {
    const conditions = [eq(trainingChapters.id, chapterId)];
    const effectiveCourseId = courseId || input.courseId;
    if (effectiveCourseId) {
      conditions.push(eq(trainingChapters.courseId, effectiveCourseId));
    }

    const [existing] = await tx
      .select()
      .from(trainingChapters)
      .where(and(...conditions))
      .limit(1);

    if (!existing) {
      throw new ApiError('Chapter not found', 404, true, '', {
        code: 'CHAPTER_NOT_FOUND',
      });
    }

    const targetCourseId = existing.courseId;

    const updateValues: Partial<typeof trainingChapters.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (input.titleEn !== undefined) updateValues.titleEn = input.titleEn;
    if (input.titleEs !== undefined) updateValues.titleEs = input.titleEs;
    if (input.subtitleEn !== undefined)
      updateValues.subtitleEn = input.subtitleEn;
    if (input.subtitleEs !== undefined)
      updateValues.subtitleEs = input.subtitleEs;
    if (input.blocks !== undefined) updateValues.blocks = input.blocks;
    if (input.procedureId !== undefined)
      updateValues.procedureId = input.procedureId;
    if (input.minCorrectAnswers !== undefined)
      updateValues.minCorrectAnswers = input.minCorrectAnswers;
    if (input.number !== undefined) updateValues.number = input.number;

    let effectiveQuizId =
      input.quizId !== undefined ? input.quizId : existing.quizId;
    let quizRecord: typeof quiz.$inferSelect | null = null;

    // Handle inline quiz payload if provided
    if (input.quiz) {
      if (input.quiz.minCorrectAnswers !== undefined) {
        updateValues.minCorrectAnswers = input.quiz.minCorrectAnswers;
      }

      if (
        Array.isArray(input.quiz.questions) &&
        input.quiz.questions.length > 0
      ) {
        let isProcedureQuiz = false;
        if (effectiveQuizId) {
          const [existingQ] = await tx
            .select({ quizType: quiz.quizType })
            .from(quiz)
            .where(eq(quiz.id, effectiveQuizId))
            .limit(1);
          if (existingQ && existingQ.quizType === 'procedure') {
            isProcedureQuiz = true;
          }
        }

        if (effectiveQuizId && !isProcedureQuiz) {
          // Update existing course quiz record
          const [updatedQuiz] = await tx
            .update(quiz)
            .set({
              questions: input.quiz.questions,
              nameEn: input.titleEn || existing.titleEn,
              nameEs: input.titleEs || existing.titleEs,
              quizType: 'course',
            })
            .where(eq(quiz.id, effectiveQuizId))
            .returning();
          quizRecord = updatedQuiz || null;
        } else {
          // Create new course quiz record (never overwrite a procedure quiz!)
          const [newQuiz] = await tx
            .insert(quiz)
            .values({
              nameEn: input.titleEn || existing.titleEn,
              nameEs: input.titleEs || existing.titleEs,
              quizType: 'course',
              questions: input.quiz.questions,
              createdBy: actor.userId || null,
            })
            .returning();
          if (newQuiz) {
            effectiveQuizId = newQuiz.id;
            quizRecord = newQuiz;
          }
        }
      }
    } else if (effectiveQuizId) {
      const [existingQuiz] = await tx
        .select()
        .from(quiz)
        .where(eq(quiz.id, effectiveQuizId))
        .limit(1);
      quizRecord = existingQuiz || null;
    }

    updateValues.quizId = effectiveQuizId;

    const [updatedChapter] = await tx
      .update(trainingChapters)
      .set(updateValues)
      .where(eq(trainingChapters.id, chapterId))
      .returning();

    if (!updatedChapter) {
      throw new ApiError('Failed to update chapter', 500);
    }

    // Update parent course's updatedAt
    await tx
      .update(trainingCourses)
      .set({ updatedAt: new Date() })
      .where(eq(trainingCourses.id, targetCourseId));

    logger.info(
      `Chapter "${updatedChapter.titleEn}" (${chapterId}) in course ${targetCourseId} updated by ${actor.userId || 'system'}`,
    );

    const chapterChanges: AuditChanges =
      diffChanges(existing, updatedChapter, [
        'titleEn',
        'titleEs',
        'subtitleEn',
        'subtitleEs',
        'number',
        'procedureId',
        'minCorrectAnswers',
      ]) ?? {};
    // Blocks are compared as label lists: the raw JSON is the document body,
    // and the labels are exactly what the audit UI can render.
    if (!isSameValue(existing.blocks, updatedChapter.blocks)) {
      chapterChanges.blocks = {
        from: summarizeBlocks(existing.blocks),
        to: summarizeBlocks(updatedChapter.blocks),
      };
    }

    await recordAudit({
      actor,
      executor: tx,
      itemType: 'chapter',
      itemId: chapterId,
      itemName: updatedChapter.titleEn,
      action: 'update',
      changes: Object.keys(chapterChanges).length > 0 ? chapterChanges : null,
    });

    return {
      ...updatedChapter,
      quiz: quizRecord
        ? {
            id: quizRecord.id,
            attached: true,
            questions: quizRecord.questions,
            minCorrectAnswers: updatedChapter.minCorrectAnswers,
          }
        : null,
    };
  });
}

/**
 * Deletes a chapter and re-indexes remaining chapter numbers for that course.
 */
export async function deleteChapter(
  chapterId: string,
  actor: AuditActor,
  courseId?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const conditions = [eq(trainingChapters.id, chapterId)];
    if (courseId) {
      conditions.push(eq(trainingChapters.courseId, courseId));
    }

    const [existing] = await tx
      .select()
      .from(trainingChapters)
      .where(and(...conditions))
      .limit(1);

    if (!existing) {
      throw new ApiError('Chapter not found', 404, true, '', {
        code: 'CHAPTER_NOT_FOUND',
      });
    }

    const targetCourseId = existing.courseId;

    await tx.delete(trainingChapters).where(eq(trainingChapters.id, chapterId));

    // Resequence remaining chapters to ensure 1, 2, 3... sequence
    const remaining = await tx
      .select({ id: trainingChapters.id })
      .from(trainingChapters)
      .where(eq(trainingChapters.courseId, targetCourseId))
      .orderBy(asc(trainingChapters.number));

    for (let i = 0; i < remaining.length; i++) {
      const ch = remaining[i];
      if (!ch) continue;
      await tx
        .update(trainingChapters)
        .set({ number: i + 1 })
        .where(eq(trainingChapters.id, ch.id));
    }

    // Update course updatedAt
    await tx
      .update(trainingCourses)
      .set({ updatedAt: new Date() })
      .where(eq(trainingCourses.id, targetCourseId));

    logger.info(
      `Chapter "${existing.titleEn}" (${chapterId}) deleted from course ${targetCourseId} by ${actor.userId || 'system'}`,
    );

    await recordAudit({
      actor,
      executor: tx,
      itemType: 'chapter',
      itemId: chapterId,
      itemName: existing.titleEn,
      action: 'delete',
      changes: {
        // What went away: the block list, or the chapter title when it had
        // no content yet — never a bare "—".
        content: {
          from: chapterContentSnapshot(existing.titleEn, existing.blocks),
          to: null,
        },
        position: { from: existing.number, to: null },
      },
    });
  });
}

/**
 * Reorders chapters within a course.
 */
export async function reorderChapters(
  courseId: string,
  input: ReorderChaptersInput,
  actor: AuditActor = {},
): Promise<ChapterWithQuiz[]> {
  return await db.transaction(async (tx) => {
    // Snapshot the old sequence (chapter titles in order) for the audit
    // entry — the temp-number dance below destroys the original numbers.
    // Sequential on purpose: a transaction is one connection, queries on it
    // must not overlap.
    const beforeRows = await tx
      .select({
        titleEn: trainingChapters.titleEn,
        number: trainingChapters.number,
      })
      .from(trainingChapters)
      .where(eq(trainingChapters.courseId, courseId))
      .orderBy(asc(trainingChapters.number));
    const [course] = await tx
      .select({ titleEn: trainingCourses.titleEn })
      .from(trainingCourses)
      .where(eq(trainingCourses.id, courseId))
      .limit(1);

    // 1. Assign temporary negative numbers to avoid unique constraint collision on (courseId, number)
    for (let i = 0; i < input.orders.length; i++) {
      const item = input.orders[i];
      if (!item) continue;
      await tx
        .update(trainingChapters)
        .set({ number: -(i + 1) })
        .where(
          and(
            eq(trainingChapters.id, item.id),
            eq(trainingChapters.courseId, courseId),
          ),
        );
    }

    // 2. Assign target numbers
    for (const item of input.orders) {
      await tx
        .update(trainingChapters)
        .set({ number: item.number, updatedAt: new Date() })
        .where(
          and(
            eq(trainingChapters.id, item.id),
            eq(trainingChapters.courseId, courseId),
          ),
        );
    }

    // Update course updatedAt
    await tx
      .update(trainingCourses)
      .set({ updatedAt: new Date() })
      .where(eq(trainingCourses.id, courseId));

    // Return final ordered list
    const rows = await tx
      .select({
        chapter: trainingChapters,
        chapterQuiz: quiz,
      })
      .from(trainingChapters)
      .leftJoin(quiz, eq(trainingChapters.quizId, quiz.id))
      .where(eq(trainingChapters.courseId, courseId))
      .orderBy(asc(trainingChapters.number));

    const beforeOrder = beforeRows.map((r) => r.titleEn);
    const afterOrder = rows.map((r) => r.chapter.titleEn);
    await recordAudit({
      actor,
      executor: tx,
      itemType: 'course',
      itemId: courseId,
      itemName: course?.titleEn ?? courseId,
      action: 'reorder',
      changes: isSameValue(beforeOrder, afterOrder)
        ? null
        : { chapters: { from: beforeOrder, to: afterOrder } },
    });

    return rows.map((r) => ({
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
  });
}
