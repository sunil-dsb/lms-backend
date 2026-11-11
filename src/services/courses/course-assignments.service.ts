import ApiError from '../../shared/utils/ApiError.ts';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  employees,
  trainingChapters,
  trainingCourseAssignments,
  trainingCourses,
  procedures,
  quiz,
  type Quiz,
  type UnassignCourseInput,
} from '../../db/index.ts';
import { logger } from '../../config/logger.ts';
import { getCourseById, type CourseWithChapters } from './courses.service.ts';

function blockKinds(blocks: unknown[]): Set<string> {
  return new Set(
    blocks.flatMap((block) =>
      block &&
      typeof block === 'object' &&
      'kind' in block &&
      typeof block.kind === 'string'
        ? [block.kind]
        : [],
    ),
  );
}

function employeeQuiz(quizValue: Quiz | null | undefined) {
  if (!quizValue) return null;
  const questions = Array.isArray(quizValue.questions)
    ? quizValue.questions.map((question) => {
        if (!question || typeof question !== 'object') return question;
        const { correctChoiceId: _answerKey, ...safeQuestion } =
          question as Record<string, unknown>;
        return safeQuestion;
      })
    : [];

  return {
    id: quizValue.id,
    nameEn: quizValue.nameEn,
    nameEs: quizValue.nameEs,
    questions,
    questionCount: questions.length,
  };
}

function hasValidAuthoredQuestion(questions: unknown): boolean {
  if (!Array.isArray(questions) || questions.length === 0) return false;
  return questions.some((q) => {
    if (!q || typeof q !== 'object') return false;
    const rec = q as Record<string, unknown>;
    const prompt = (rec.prompt ?? rec.question ?? rec.title) as
      string | { en?: string; es?: string } | undefined;
    const promptText =
      typeof prompt === 'string'
        ? prompt.trim()
        : String(prompt?.en ?? prompt?.es ?? '').trim();
    const choices = rec.choices;
    const hasChoices =
      Array.isArray(choices) &&
      choices.some((c) => {
        if (!c || typeof c !== 'object') return false;
        const cRec = c as Record<string, unknown>;
        const lbl = (cRec.label ?? cRec.text) as
          string | { en?: string; es?: string } | undefined;
        return typeof lbl === 'string'
          ? lbl.trim().length > 0
          : Boolean(
              (typeof lbl?.en === 'string' && lbl.en.trim()) ||
              (typeof lbl?.es === 'string' && lbl.es.trim()),
            );
      });
    return Boolean(promptText || hasChoices);
  });
}

function chapterDisplayData(chapter: CourseWithChapters['chapters'][number]) {
  const blocks = Array.isArray(chapter.blocks) ? chapter.blocks : [];
  const kinds = blockKinds(blocks);
  const safeQuiz = employeeQuiz(chapter.quiz as Quiz | null | undefined);
  const linkedProcedureBlock = blocks.some(
    (block) =>
      block &&
      typeof block === 'object' &&
      'kind' in block &&
      block.kind === 'linked_procedures',
  );

  return {
    id: chapter.id,
    courseId: chapter.courseId,
    number: chapter.number,
    titleEn: chapter.titleEn,
    titleEs: chapter.titleEs,
    subtitleEn: chapter.subtitleEn,
    subtitleEs: chapter.subtitleEs,
    blocks,
    procedureId: chapter.procedureId,
    quizId: chapter.quizId,
    minCorrectAnswers: chapter.minCorrectAnswers,
    quiz: safeQuiz,
    hasQuiz: (safeQuiz?.questionCount ?? 0) > 0,
    quizQuestionsCount: safeQuiz?.questionCount ?? 0,
    hasVideo: kinds.has('video'),
    hasChecklist: kinds.has('checklist') || kinds.has('method'),
    hasRecipe: kinds.has('ingredients') || kinds.has('recipe'),
    hasProcedure: Boolean(chapter.procedureId) || linkedProcedureBlock,
  };
}

/** Lists only the authenticated employee's assigned training courses. */
export async function listEmployeeTraining(employeeId: string) {
  const assignments = await db
    .select({
      assignmentId: trainingCourseAssignments.id,
      courseId: trainingCourses.id,
      titleEn: trainingCourses.titleEn,
      titleEs: trainingCourses.titleEs,
      purposeEn: trainingCourses.purposeEn,
      purposeEs: trainingCourses.purposeEs,
      courseStatus: trainingCourses.status,
      isRequired: trainingCourseAssignments.isRequired,
      dueDate: trainingCourseAssignments.dueDate,
      assignedAt: trainingCourseAssignments.assignedAt,
      currentChapterId: trainingCourseAssignments.currentChapterId,
      courseCompletedAt: trainingCourseAssignments.courseCompletedAt,
      currentChapterNumber: trainingChapters.number,
      currentChapterTitleEn: trainingChapters.titleEn,
      currentChapterTitleEs: trainingChapters.titleEs,
    })
    .from(trainingCourseAssignments)
    .innerJoin(
      trainingCourses,
      eq(trainingCourseAssignments.courseId, trainingCourses.id),
    )
    .leftJoin(
      trainingChapters,
      eq(trainingCourseAssignments.currentChapterId, trainingChapters.id),
    )
    .where(
      and(
        eq(trainingCourseAssignments.employeeId, employeeId),
        eq(trainingCourses.status, 'published'),
      ),
    )
    .orderBy(desc(trainingCourseAssignments.assignedAt));

  if (assignments.length === 0) return [];

  const chapterCounts = await db
    .select({ courseId: trainingChapters.courseId, chapterCount: count() })
    .from(trainingChapters)
    .where(
      inArray(
        trainingChapters.courseId,
        assignments.map((a) => a.courseId),
      ),
    )
    .groupBy(trainingChapters.courseId);
  const countsByCourse = new Map(
    chapterCounts.map((row) => [row.courseId, Number(row.chapterCount)]),
  );

  return assignments.map((assignment) => {
    const chapterCount = countsByCourse.get(assignment.courseId) ?? 0;
    const completed = Boolean(assignment.courseCompletedAt);
    const completedChapterCount = completed
      ? chapterCount
      : Math.max((assignment.currentChapterNumber ?? 1) - 1, 0);
    return {
      ...assignment,
      chapterCount,
      completedChapterCount,
      progressPercent: chapterCount
        ? Math.round((completedChapterCount / chapterCount) * 100)
        : 0,
      status: completed ? 'complete' : 'in_progress',
    };
  });
}

export interface EmployeeRequiredTrainingStatus {
  requiredCount: number;
  completedCount: number;
  isComplete: boolean;
}

/** Required courses are the published, required courses assigned to this employee. */
export async function getEmployeeRequiredTrainingStatus(
  employeeId: string,
): Promise<EmployeeRequiredTrainingStatus> {
  const requiredAssignments = await db
    .select({ courseCompletedAt: trainingCourseAssignments.courseCompletedAt })
    .from(trainingCourseAssignments)
    .innerJoin(
      trainingCourses,
      eq(trainingCourseAssignments.courseId, trainingCourses.id),
    )
    .where(
      and(
        eq(trainingCourseAssignments.employeeId, employeeId),
        eq(trainingCourses.status, 'published'),
        eq(trainingCourseAssignments.isRequired, true),
      ),
    );

  const completedCount = requiredAssignments.filter(
    (assignment) => assignment.courseCompletedAt !== null,
  ).length;

  return {
    requiredCount: requiredAssignments.length,
    completedCount,
    isComplete: completedCount === requiredAssignments.length,
  };
}

/** Blocks nonessential employee content until every required assignment is complete. */
export async function assertEmployeeHasCompletedRequiredTraining(
  employeeId: string,
): Promise<void> {
  const requiredTraining = await getEmployeeRequiredTrainingStatus(employeeId);
  if (requiredTraining.isComplete) return;

  throw new ApiError(
    'Complete required training before opening other LMS sections',
    403,
    true,
    '',
    {
      code: 'COURSE_LOCKED_BY_REQUIRED_TRAINING',
      details: requiredTraining,
    },
  );
}

/** Returns true when this procedure is included in a required course assigned
 *  to the employee. This lets them read course material before completing all
 *  required training without opening the procedure outside that course path. */
export async function isProcedureInEmployeeRequiredCourse(
  employeeId: string,
  courseId: string,
  procedureIdOrSlug: string,
): Promise<boolean> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      courseId,
    )
  ) {
    return false;
  }

  const [assignment] = await db
    .select({ isRequired: trainingCourseAssignments.isRequired })
    .from(trainingCourseAssignments)
    .innerJoin(
      trainingCourses,
      eq(trainingCourseAssignments.courseId, trainingCourses.id),
    )
    .where(
      and(
        eq(trainingCourseAssignments.courseId, courseId),
        eq(trainingCourseAssignments.employeeId, employeeId),
        eq(trainingCourses.status, 'published'),
      ),
    )
    .limit(1);

  if (!assignment?.isRequired) return false;

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      procedureIdOrSlug,
    );
  const procedureCondition = isUuid
    ? or(
        eq(procedures.id, procedureIdOrSlug),
        eq(procedures.slug, procedureIdOrSlug),
      )
    : eq(procedures.slug, procedureIdOrSlug);
  const [procedure] = await db
    .select({ id: procedures.id })
    .from(procedures)
    .where(procedureCondition!)
    .limit(1);

  if (!procedure) return false;

  const course = await getCourseById(courseId);
  return course.chapters.some((chapter) => {
    if (chapter.procedureId === procedure.id) return true;
    const blocks = Array.isArray(chapter.blocks) ? chapter.blocks : [];
    return blocks.some(
      (block) =>
        block &&
        typeof block === 'object' &&
        'kind' in block &&
        block.kind === 'linked_procedures' &&
        'procedureIds' in block &&
        Array.isArray(block.procedureIds) &&
        block.procedureIds.includes(procedure.id),
    );
  });
}

/**
 * Automatically checks if there are any published courses for this employee's station(s)
 * that have not yet been assigned to them, and creates the assignments.
 */
export async function syncEmployeeStationCourses(
  employeeId: string,
): Promise<number> {
  const [emp] = await db
    .select({
      id: employees.id,
      stationIds: employees.stationIds,
      status: employees.status,
    })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);

  if (
    !emp ||
    emp.status === 'deactivated' ||
    !emp.stationIds ||
    emp.stationIds.length === 0
  ) {
    return 0;
  }

  const matchingCourses = await db
    .select({
      id: trainingCourses.id,
      assignUsers: trainingCourses.assignUsers,
    })
    .from(trainingCourses)
    .where(
      and(
        eq(trainingCourses.status, 'published'),
        sql`${trainingCourses.stationIds} && ARRAY[${sql.join(
          emp.stationIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`,
      ),
    );

  if (matchingCourses.length === 0) {
    return 0;
  }

  const existingAssignments = await db
    .select({ courseId: trainingCourseAssignments.courseId })
    .from(trainingCourseAssignments)
    .where(eq(trainingCourseAssignments.employeeId, employeeId));

  const assignedCourseIds = new Set(existingAssignments.map((a) => a.courseId));
  const coursesToAssign = matchingCourses.filter(
    (c) => !assignedCourseIds.has(c.id),
  );

  if (coursesToAssign.length === 0) {
    return 0;
  }

  const defaultDue = new Date();
  defaultDue.setDate(defaultDue.getDate() + 7);
  const dueDateStr = defaultDue.toISOString().slice(0, 10);

  let newlyAssignedCount = 0;

  for (const course of coursesToAssign) {
    const [firstChapter] = await db
      .select({ id: trainingChapters.id })
      .from(trainingChapters)
      .where(eq(trainingChapters.courseId, course.id))
      .orderBy(asc(trainingChapters.number))
      .limit(1);

    await db
      .insert(trainingCourseAssignments)
      .values({
        courseId: course.id,
        employeeId,
        dueDate: dueDateStr,
        isRequired: true,
        currentChapterId: firstChapter?.id ?? null,
      })
      .onConflictDoNothing({
        target: [
          trainingCourseAssignments.courseId,
          trainingCourseAssignments.employeeId,
        ],
      });

    const currentUsers = course.assignUsers || [];
    if (!currentUsers.includes(employeeId)) {
      await db
        .update(trainingCourses)
        .set({
          assignUsers: [...currentUsers, employeeId],
          updatedAt: new Date(),
        })
        .where(eq(trainingCourses.id, course.id));
    }

    newlyAssignedCount++;
  }

  return newlyAssignedCount;
}

/** Employee list: every assignment stays visible. Non-required courses carry
 *  `locked: true` while any required course is incomplete, so the client can
 *  render them as locked blocks (like the Home and Procedures lock states) and
 *  the detail endpoint still refuses deep links (`assertEmployeeCanAccessTrainingCourse`). */
export async function listAvailableEmployeeTraining(employeeId: string) {
  // Whenever an employee opens dashboard or training, ensure any published courses
  // for their assigned stations are synced and assigned.
  try {
    await syncEmployeeStationCourses(employeeId);
  } catch (err) {
    logger.error(
      `Failed to auto-sync station courses for employee ${employeeId}:`,
      err,
    );
  }

  const assignments = await listEmployeeTraining(employeeId);
  const requiredTraining = {
    requiredCount: assignments.filter((a) => a.isRequired).length,
    completedCount: assignments.filter(
      (a) => a.isRequired && a.courseCompletedAt !== null,
    ).length,
    isComplete: false,
  };
  requiredTraining.isComplete =
    requiredTraining.completedCount === requiredTraining.requiredCount;
  const requiredDone = requiredTraining.isComplete;

  return {
    assignments: assignments.map((assignment) => ({
      ...assignment,
      locked: !assignment.isRequired && !requiredDone,
    })),
    requiredTraining: {
      ...requiredTraining,
      lockedCount: requiredDone
        ? 0
        : assignments.filter((assignment) => !assignment.isRequired).length,
    },
  };
}

/** Ensures the employee is assigned, the course is published, and the prerequisite gate is clear. */
export async function assertEmployeeCanAccessTrainingCourse(
  courseId: string,
  employeeId: string,
): Promise<void> {
  const [courseAssignment] = await db
    .select({
      courseStatus: trainingCourses.status,
      isRequired: trainingCourseAssignments.isRequired,
    })
    .from(trainingCourseAssignments)
    .innerJoin(
      trainingCourses,
      eq(trainingCourseAssignments.courseId, trainingCourses.id),
    )
    .where(
      and(
        eq(trainingCourseAssignments.courseId, courseId),
        eq(trainingCourseAssignments.employeeId, employeeId),
        eq(trainingCourses.status, 'published'),
      ),
    )
    .limit(1);

  if (!courseAssignment) {
    throw new ApiError('Course assignment not found', 404, true, '', {
      code: 'COURSE_ASSIGNMENT_NOT_FOUND',
    });
  }

  if (!courseAssignment.isRequired) {
    const requiredTraining =
      await getEmployeeRequiredTrainingStatus(employeeId);
    if (!requiredTraining.isComplete) {
      throw new ApiError(
        'Complete required training before opening other courses',
        403,
        true,
        '',
        {
          code: 'COURSE_LOCKED_BY_REQUIRED_TRAINING',
          details: requiredTraining,
        },
      );
    }
  }
}

/** Fetches chapter content and progress for one assigned employee course. */
export async function getEmployeeTrainingCourse(
  courseId: string,
  employeeId: string,
) {
  await assertEmployeeCanAccessTrainingCourse(courseId, employeeId);

  const [assignment] = await db
    .select()
    .from(trainingCourseAssignments)
    .where(
      and(
        eq(trainingCourseAssignments.courseId, courseId),
        eq(trainingCourseAssignments.employeeId, employeeId),
      ),
    )
    .limit(1);

  if (!assignment) {
    throw new ApiError('Course assignment not found', 404, true, '', {
      code: 'COURSE_ASSIGNMENT_NOT_FOUND',
    });
  }

  const course = await getCourseById(courseId);
  if (course.status !== 'published') {
    throw new ApiError('Course not found', 404, true, '', {
      code: 'COURSE_NOT_FOUND',
    });
  }
  const chapters = course.chapters.map(chapterDisplayData);
  const currentIndex = chapters.findIndex(
    (chapter) => chapter.id === assignment.currentChapterId,
  );
  const completedChapterCount = assignment.courseCompletedAt
    ? chapters.length
    : Math.max(currentIndex, 0);

  return {
    assignment: {
      id: assignment.id,
      dueDate: assignment.dueDate,
      assignedAt: assignment.assignedAt,
      currentChapterId: assignment.currentChapterId,
      courseCompletedAt: assignment.courseCompletedAt,
      completedChapterCount,
      totalChapters: chapters.length,
      progressPercent: chapters.length
        ? Math.round((completedChapterCount / chapters.length) * 100)
        : 0,
      status: assignment.courseCompletedAt ? 'complete' : 'in_progress',
    },
    course: {
      id: course.id,
      titleEn: course.titleEn,
      titleEs: course.titleEs,
      purposeEn: course.purposeEn,
      purposeEs: course.purposeEs,
      chapters,
    },
  };
}

/**
 * Assigns or updates assigned employees on a training course.
 */
export async function assignCourse(
  courseId: string,
  input: {
    employeeIds: string[];
    stationIds?: string[] | undefined;
    dueDate: string;
    isRequired?: boolean | undefined;
    mode?: 'add' | 'replace' | undefined;
  },
): Promise<{ courseId: string; assignedCount: number; assignUsers: string[] }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: trainingCourses.id,
        titleEn: trainingCourses.titleEn,
        assignUsers: trainingCourses.assignUsers,
      })
      .from(trainingCourses)
      .where(eq(trainingCourses.id, courseId))
      .limit(1);

    if (!existing) {
      throw new ApiError('Training course not found', 404, true, '', {
        code: 'COURSE_NOT_FOUND',
      });
    }

    const chapters = await tx
      .select({
        id: trainingChapters.id,
        number: trainingChapters.number,
        titleEn: trainingChapters.titleEn,
        quizId: trainingChapters.quizId,
        questions: quiz.questions,
      })
      .from(trainingChapters)
      .leftJoin(quiz, eq(trainingChapters.quizId, quiz.id))
      .where(eq(trainingChapters.courseId, courseId))
      .orderBy(asc(trainingChapters.number));

    if (chapters.length === 0) {
      throw new ApiError(
        'Cannot assign course: The course must have at least one chapter.',
        400,
        true,
        '',
        { code: 'COURSE_HAS_NO_CHAPTERS' },
      );
    }

    const chaptersWithoutQuestions = chapters.filter(
      (ch) => !ch.quizId || !hasValidAuthoredQuestion(ch.questions),
    );

    if (chaptersWithoutQuestions.length > 0) {
      const chapterNumbers = chaptersWithoutQuestions
        .map((ch) => ch.number)
        .join(', ');
      throw new ApiError(
        `Cannot assign course: Chapter(s) ${chapterNumbers} do not have any quiz questions. Every chapter must have at least one question to track employee progress.`,
        400,
        true,
        '',
        {
          code: 'CHAPTERS_MISSING_QUIZ_QUESTIONS',
          details: {
            chapterNumbers: chaptersWithoutQuestions.map((ch) => ch.number),
          },
        },
      );
    }

    const firstChapter = chapters[0];

    // Combine any explicitly provided employeeIds with employees belonging to input.stationIds
    let targetEmployeeIds = Array.from(new Set(input.employeeIds || []));
    if (input.stationIds && input.stationIds.length > 0) {
      const stationEmployees = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(
          and(
            inArray(employees.status, ['active', 'pending']),
            sql`${employees.stationIds} && ARRAY[${sql.join(
              input.stationIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`,
          ),
        );
      targetEmployeeIds = Array.from(
        new Set([...targetEmployeeIds, ...stationEmployees.map((e) => e.id)]),
      );
    }

    if (targetEmployeeIds.length > 0) {
      const validEmployees = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(
          and(
            inArray(employees.id, targetEmployeeIds),
            inArray(employees.status, ['active', 'pending']),
          ),
        );
      if (validEmployees.length !== targetEmployeeIds.length) {
        throw new ApiError(
          'One or more employees are missing, pending or deactivated',
          400,
          true,
          '',
          {
            code: 'INVALID_EMPLOYEE_IDS',
          },
        );
      }
    }

    if (input.mode === 'replace') {
      await tx
        .delete(trainingCourseAssignments)
        .where(
          and(
            eq(trainingCourseAssignments.courseId, courseId),
            targetEmployeeIds.length > 0
              ? notInArray(
                  trainingCourseAssignments.employeeId,
                  targetEmployeeIds,
                )
              : sql`true`,
          ),
        );
      if (targetEmployeeIds.length > 0) {
        await tx
          .insert(trainingCourseAssignments)
          .values(
            targetEmployeeIds.map((employeeId) => ({
              courseId,
              employeeId,
              dueDate: input.dueDate,
              isRequired: input.isRequired ?? false,
              currentChapterId: firstChapter?.id ?? null,
            })),
          )
          .onConflictDoUpdate({
            target: [
              trainingCourseAssignments.courseId,
              trainingCourseAssignments.employeeId,
            ],
            set: {
              dueDate: input.dueDate,
              isRequired: input.isRequired ?? false,
              currentChapterId: firstChapter?.id ?? null,
              courseCompletedAt: null,
            },
          });
      }
    } else if (targetEmployeeIds.length > 0) {
      await tx
        .insert(trainingCourseAssignments)
        .values(
          targetEmployeeIds.map((employeeId) => ({
            courseId,
            employeeId,
            dueDate: input.dueDate,
            isRequired: input.isRequired ?? false,
            currentChapterId: firstChapter?.id ?? null,
          })),
        )
        .onConflictDoNothing({
          target: [
            trainingCourseAssignments.courseId,
            trainingCourseAssignments.employeeId,
          ],
        });
    }

    const current = existing.assignUsers || [];
    const nextUsers =
      input.mode === 'replace'
        ? targetEmployeeIds
        : Array.from(new Set([...current, ...targetEmployeeIds]));

    const courseUpdates: Record<string, unknown> = {
      assignUsers: nextUsers,
      updatedAt: new Date(),
    };
    if (input.stationIds !== undefined) {
      const currentStations = existing.stationIds || [];
      courseUpdates.stationIds =
        input.mode === 'replace'
          ? input.stationIds
          : Array.from(new Set([...currentStations, ...input.stationIds]));
    }

    await tx
      .update(trainingCourses)
      .set(courseUpdates)
      .where(eq(trainingCourses.id, courseId));

    logger.info(
      `Course "${existing.titleEn}" (${courseId}) assigned to ${targetEmployeeIds.length} employees`,
    );

    return {
      courseId,
      assignedCount: targetEmployeeIds.length,
      assignUsers: nextUsers,
    };
  });
}

/**
 * Unassigns one or more employees from a training course.
 */
export async function unassignCourse(
  courseId: string,
  input: UnassignCourseInput,
): Promise<{
  courseId: string;
  unassignedCount: number;
  remainingCount: number;
}> {
  const employeeIds = Array.from(new Set(input.employeeIds));

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: trainingCourses.id,
        titleEn: trainingCourses.titleEn,
        assignUsers: trainingCourses.assignUsers,
      })
      .from(trainingCourses)
      .where(eq(trainingCourses.id, courseId))
      .limit(1);

    if (!existing) {
      throw new ApiError('Training course not found', 404, true, '', {
        code: 'COURSE_NOT_FOUND',
      });
    }

    if (employeeIds.length === 0) {
      return {
        courseId,
        unassignedCount: 0,
        remainingCount: (existing.assignUsers || []).length,
      };
    }

    // 1. Delete matching assignments from trainingCourseAssignments
    await tx
      .delete(trainingCourseAssignments)
      .where(
        and(
          eq(trainingCourseAssignments.courseId, courseId),
          inArray(trainingCourseAssignments.employeeId, employeeIds),
        ),
      );

    // 2. Remove employeeIds from trainingCourses.assignUsers
    const currentUsers = existing.assignUsers || [];
    const unassignSet = new Set(employeeIds);
    const nextUsers = currentUsers.filter((id) => !unassignSet.has(id));

    await tx
      .update(trainingCourses)
      .set({ assignUsers: nextUsers, updatedAt: new Date() })
      .where(eq(trainingCourses.id, courseId));

    logger.info(
      `Course "${existing.titleEn}" (${courseId}) unassigned from ${employeeIds.length} employees`,
    );

    return {
      courseId,
      unassignedCount: employeeIds.length,
      remainingCount: nextUsers.length,
    };
  });
}

/**
 * Returns all assigned employees for a training course.
 */
export async function listCourseAssignments(courseId: string) {
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

  const todayStart = new Date().setHours(0, 0, 0, 0);
  const rows = await db
    .select({
      id: trainingCourseAssignments.id,
      courseId: trainingCourseAssignments.courseId,
      employeeId: trainingCourseAssignments.employeeId,
      isRequired: trainingCourseAssignments.isRequired,
      dueDate: trainingCourseAssignments.dueDate,
      currentChapterId: trainingCourseAssignments.currentChapterId,
      courseCompletedAt: trainingCourseAssignments.courseCompletedAt,
      assignedAt: trainingCourseAssignments.assignedAt,
      currentChapterNumber: trainingChapters.number,
      currentChapterTitleEn: trainingChapters.titleEn,
      currentChapterTitleEs: trainingChapters.titleEs,
      employeeName: employees.name,
      employeeEmail: employees.email,
      employeeStatus: employees.status,
    })
    .from(trainingCourseAssignments)
    .innerJoin(
      employees,
      eq(trainingCourseAssignments.employeeId, employees.id),
    )
    .leftJoin(
      trainingChapters,
      eq(trainingCourseAssignments.currentChapterId, trainingChapters.id),
    )
    .where(eq(trainingCourseAssignments.courseId, courseId))
    .orderBy(desc(trainingCourseAssignments.assignedAt));

  const [chapterCountRow] = await db
    .select({ chapterCount: count() })
    .from(trainingChapters)
    .where(eq(trainingChapters.courseId, courseId));
  const chapterCount = Number(chapterCountRow?.chapterCount ?? 0);

  return rows.map((r) => {
    const isCompleted = r.courseCompletedAt !== null;
    const isOverdue =
      !isCompleted && new Date(r.dueDate).getTime() < todayStart;
    const status = isCompleted
      ? 'complete'
      : isOverdue
        ? 'overdue'
        : 'in_progress';
    const completedChapterCount = isCompleted
      ? chapterCount
      : Math.max((r.currentChapterNumber ?? 1) - 1, 0);

    return {
      id: r.id,
      courseId: r.courseId,
      employeeId: r.employeeId,
      isRequired: r.isRequired,
      dueDate: r.dueDate,
      dueAt: r.dueDate,
      assignedAt: r.assignedAt.toISOString(),
      currentChapterId: r.currentChapterId,
      currentChapterNumber: r.currentChapterNumber,
      currentChapterTitleEn: r.currentChapterTitleEn,
      currentChapterTitleEs: r.currentChapterTitleEs,
      courseCompletedAt: r.courseCompletedAt
        ? r.courseCompletedAt.toISOString()
        : null,
      chapterCount,
      completedChapterCount,
      progressPercent: chapterCount
        ? Math.round((completedChapterCount / chapterCount) * 100)
        : 0,
      status,
      employee: {
        id: r.employeeId,
        name: r.employeeName,
        email: r.employeeEmail,
        status: r.employeeStatus,
      },
    };
  });
}
