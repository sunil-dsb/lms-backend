import ApiError from '../../shared/utils/ApiError.ts';
import { and, asc, count, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  employees,
  trainingChapters,
  trainingCourseAssignments,
  trainingCourses,
  quiz,
  type Quiz,
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

/** Fetches chapter content and progress for one assigned employee course. */
export async function getEmployeeTrainingCourse(
  courseId: string,
  employeeId: string,
) {
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
    dueDate: string;
    mode?: 'add' | 'replace' | undefined;
  },
): Promise<{ courseId: string; assignedCount: number; assignUsers: string[] }> {
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

    const validEmployees = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(
          inArray(employees.id, employeeIds),
          inArray(employees.status, ['active', 'pending']),
        ),
      );
    if (validEmployees.length !== employeeIds.length) {
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

    if (input.mode === 'replace') {
      await tx
        .delete(trainingCourseAssignments)
        .where(
          and(
            eq(trainingCourseAssignments.courseId, courseId),
            notInArray(trainingCourseAssignments.employeeId, employeeIds),
          ),
        );
      await tx
        .insert(trainingCourseAssignments)
        .values(
          employeeIds.map((employeeId) => ({
            courseId,
            employeeId,
            dueDate: input.dueDate,
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
            currentChapterId: firstChapter?.id ?? null,
            courseCompletedAt: null,
          },
        });
    } else {
      await tx
        .insert(trainingCourseAssignments)
        .values(
          employeeIds.map((employeeId) => ({
            courseId,
            employeeId,
            dueDate: input.dueDate,
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
        ? employeeIds
        : Array.from(new Set([...current, ...employeeIds]));
    await tx
      .update(trainingCourses)
      .set({ assignUsers: nextUsers, updatedAt: new Date() })
      .where(eq(trainingCourses.id, courseId));

    logger.info(
      `Course "${existing.titleEn}" (${courseId}) assigned to ${nextUsers.length} employees`,
    );

    return {
      courseId,
      assignedCount: nextUsers.length,
      assignUsers: nextUsers,
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
