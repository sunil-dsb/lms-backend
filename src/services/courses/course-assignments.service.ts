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
  type AuditChanges,
  type EmployeeStatus,
  type Quiz,
  type TrainingCourseStatus,
  type UnassignCourseInput,
} from '../../db/index.ts';
import { logger } from '../../config/logger.ts';
import { getCourseById, type CourseWithChapters } from './courses.service.ts';
import {
  recordAudit,
  isSameValue,
  type AuditActor,
} from '../audit/audit.service.ts';

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

/**
 * Row shape of the two selects in listEmployeeTraining. The catch-branch
 * fallback queries an older schema without the override columns, so those
 * four fields are optional here — the mapper below always writes them out
 * explicitly (missing key → null), which is why the return shape is stable.
 */
type EmployeeTrainingRow = {
  assignmentId: string;
  courseId: string;
  titleEn: string;
  titleEs: string;
  purposeEn: string;
  purposeEs: string;
  courseStatus: TrainingCourseStatus;
  isRequired: boolean;
  dueDate: string;
  assignedAt: Date;
  currentChapterId: string | null;
  courseCompletedAt: Date | null;
  overrideUntil?: Date | null;
  overriddenBy?: string | null;
  overriddenAt?: Date | null;
  overrideReason?: string | null;
  currentChapterNumber: number | null;
  currentChapterTitleEn: string | null;
  currentChapterTitleEs: string | null;
};

/** Lists only the authenticated employee's assigned training courses. */
export async function listEmployeeTraining(employeeId: string) {
  let assignments: EmployeeTrainingRow[];
  try {
    assignments = await db
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
        overrideUntil: trainingCourseAssignments.overrideUntil,
        overriddenBy: trainingCourseAssignments.overriddenBy,
        overriddenAt: trainingCourseAssignments.overriddenAt,
        overrideReason: trainingCourseAssignments.overrideReason,
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
  } catch (_err) {
    assignments = await db
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
  }

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

  const todayStr = new Date().toISOString().slice(0, 10);
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  return assignments.map((assignment) => {
    const chapterCount = countsByCourse.get(assignment.courseId) ?? 0;
    const completed = Boolean(assignment.courseCompletedAt);
    const completedChapterCount = completed
      ? chapterCount
      : Math.max((assignment.currentChapterNumber ?? 1) - 1, 0);

    const dueDateObj = new Date(assignment.dueDate);
    dueDateObj.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil(
      (dueDateObj.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    let status:
      'complete' | 'overdue' | 'due_soon' | 'in_progress' | 'not_started';

    if (completed) {
      status = 'complete';
    } else if (assignment.dueDate < todayStr) {
      status = 'overdue';
    } else if (diffDays >= 0 && diffDays <= 3) {
      status = 'due_soon';
    } else if (completedChapterCount > 0) {
      status = 'in_progress';
    } else {
      status = 'not_started';
    }

    const isOverridden = Boolean(
      assignment.overrideUntil &&
      new Date(assignment.overrideUntil) > new Date() &&
      !completed,
    );

    return {
      ...assignment,
      chapterCount,
      completedChapterCount,
      progressPercent: chapterCount
        ? Math.round((completedChapterCount / chapterCount) * 100)
        : 0,
      status,
      overrideUntil: assignment.overrideUntil
        ? assignment.overrideUntil.toISOString()
        : null,
      overriddenBy: assignment.overriddenBy ?? null,
      overriddenAt: assignment.overriddenAt
        ? assignment.overriddenAt.toISOString()
        : null,
      overrideReason: assignment.overrideReason ?? null,
      isOverridden,
    };
  });
}

export interface EmployeeRequiredTrainingStatus {
  requiredCount: number;
  completedCount: number;
  isComplete: boolean;
  isOverridden: boolean;
  overrideUntil: string | null;
  overrideReason: string | null;
  /**
   * Employee-side locks (procedures, home blocks, non-required courses) are
   * active: some incomplete required course is past its due date and has no
   * active override. Being assigned is never enough on its own.
   */
  isRestricted: boolean;
  /**
   * First moment locks activate — midnight after the earliest incomplete
   * due date (ISO); null when nothing is incomplete. Carried in the payload
   * so the employee UI can show "locks on <date>" without another API change.
   */
  restrictAt: string | null;
}

/** Required courses are the published, required courses assigned to this employee. */
export async function getEmployeeRequiredTrainingStatus(
  employeeId: string,
): Promise<EmployeeRequiredTrainingStatus> {
  let requiredAssignments: Array<{
    courseCompletedAt: Date | null;
    dueDate: string;
    overrideUntil?: Date | null;
    overrideReason?: string | null;
  }>;

  try {
    requiredAssignments = await db
      .select({
        courseCompletedAt: trainingCourseAssignments.courseCompletedAt,
        dueDate: trainingCourseAssignments.dueDate,
        overrideUntil: trainingCourseAssignments.overrideUntil,
        overrideReason: trainingCourseAssignments.overrideReason,
      })
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
  } catch (_err) {
    const fallback = await db
      .select({
        courseCompletedAt: trainingCourseAssignments.courseCompletedAt,
        dueDate: trainingCourseAssignments.dueDate,
      })
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
    requiredAssignments = fallback.map((r) => ({
      courseCompletedAt: r.courseCompletedAt,
      dueDate: r.dueDate,
      overrideUntil: null,
      overrideReason: null,
    }));
  }

  const completedCount = requiredAssignments.filter(
    (assignment) => assignment.courseCompletedAt !== null,
  ).length;

  const isComplete =
    requiredAssignments.length > 0 &&
    completedCount === requiredAssignments.length;

  const incompleteAssignments = requiredAssignments.filter(
    (assignment) => assignment.courseCompletedAt === null,
  );

  const now = new Date();
  const hasActiveOverride = (a: { overrideUntil?: Date | null }): boolean =>
    Boolean(a.overrideUntil && new Date(a.overrideUntil) > now);
  const activeOverrides = incompleteAssignments.filter(hasActiveOverride);

  const isOverridden =
    !isComplete &&
    incompleteAssignments.length > 0 &&
    activeOverrides.length === incompleteAssignments.length;

  const overrideUntil = isOverridden
    ? (activeOverrides
        .map((a) => a.overrideUntil!)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0]
        ?.toISOString() ?? null)
    : null;

  const overrideReason = isOverridden
    ? (activeOverrides[0]?.overrideReason ?? null)
    : null;

  // Restrictions begin only AFTER the due date: on the due date itself the
  // employee still has full access, and being assigned alone never takes
  // access away. dueDate is 'YYYY-MM-DD'; compare local midnights like the
  // rest of the due-date code does.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const lockStartMs = (dueDate: string): number => {
    const due = new Date(dueDate);
    due.setHours(0, 0, 0, 0);
    // The first restricted day is the day after the due date.
    due.setDate(due.getDate() + 1);
    return due.getTime();
  };

  // A course only blocks while past its due date AND without an active
  // override — overrides are per-course, so the employee stays locked until
  // every overdue course carries an active override.
  const isRestricted = incompleteAssignments.some(
    (a) =>
      lockStartMs(a.dueDate) <= todayStart.getTime() && !hasActiveOverride(a),
  );

  // First moment locks activate (midnight after the earliest incomplete due
  // date); null when nothing is incomplete.
  const restrictAt =
    incompleteAssignments.length > 0
      ? new Date(
          Math.min(...incompleteAssignments.map((a) => lockStartMs(a.dueDate))),
        ).toISOString()
      : null;

  return {
    requiredCount: requiredAssignments.length,
    completedCount,
    isComplete,
    isOverridden,
    overrideUntil,
    overrideReason,
    isRestricted,
    restrictAt,
  };
}

/**
 * Blocks nonessential employee content only once restrictions are active:
 * an incomplete required course past its due date without an active
 * override. Before the due date passes the employee keeps full access.
 */
export async function assertEmployeeHasCompletedRequiredTraining(
  employeeId: string,
): Promise<void> {
  const requiredTraining = await getEmployeeRequiredTrainingStatus(employeeId);
  if (!requiredTraining.isRestricted) return;

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
 *  `locked: true` while restrictions are active (an incomplete required
 *  course past its due date), so the client can
 *  render them as locked blocks (like the Home and Procedures lock states) and
 *  the detail endpoint still refuses deep links (`assertEmployeeCanAccessTrainingCourse`). */
export async function listAvailableEmployeeTraining(employeeId: string) {
  // Whenever an employee opens dashboard or training, ensure any published courses
  // for their assigned stations are synced and assigned.
  try {
    await syncEmployeeStationCourses(employeeId);
  } catch (err) {
    logger.error(
      { err },
      `Failed to auto-sync station courses for employee ${employeeId}`,
    );
  }

  const assignments = await listEmployeeTraining(employeeId);
  const requiredTraining = await getEmployeeRequiredTrainingStatus(employeeId);
  // Cards lock only while restrictions are active — an assignment whose due
  // date hasn't passed yet leaves everything open.
  const restricted = requiredTraining.isRestricted;

  return {
    assignments: assignments.map((assignment) => ({
      ...assignment,
      locked: !assignment.isRequired && restricted,
    })),
    requiredTraining: {
      ...requiredTraining,
      lockedCount: restricted
        ? assignments.filter((assignment) => !assignment.isRequired).length
        : 0,
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
    if (requiredTraining.isRestricted) {
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

  const todayStr = new Date().toISOString().slice(0, 10);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const dueDateObj = new Date(assignment.dueDate);
  dueDateObj.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil(
    (dueDateObj.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
  );

  let detailStatus:
    'complete' | 'overdue' | 'due_soon' | 'in_progress' | 'not_started';

  if (assignment.courseCompletedAt) {
    detailStatus = 'complete';
  } else if (assignment.dueDate < todayStr) {
    detailStatus = 'overdue';
  } else if (diffDays >= 0 && diffDays <= 3) {
    detailStatus = 'due_soon';
  } else if (completedChapterCount > 0) {
    detailStatus = 'in_progress';
  } else {
    detailStatus = 'not_started';
  }

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
      status: detailStatus,
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
  actor: AuditActor,
): Promise<{ courseId: string; assignedCount: number; assignUsers: string[] }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: trainingCourses.id,
        titleEn: trainingCourses.titleEn,
        assignUsers: trainingCourses.assignUsers,
        stationIds: trainingCourses.stationIds,
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

    await recordAudit({
      actor,
      executor: tx,
      itemType: 'assignment',
      itemId: courseId,
      itemName: existing.titleEn,
      action: 'assign',
      changes: {
        employees: {
          from: null,
          to: targetEmployeeIds,
        },
        dueDate: { from: null, to: input.dueDate },
        isRequired: { from: null, to: input.isRequired ?? false },
        mode: { from: null, to: input.mode ?? 'add' },
      },
    });

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
  actor: AuditActor,
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
        stationIds: trainingCourses.stationIds,
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

    await recordAudit({
      actor,
      executor: tx,
      itemType: 'assignment',
      itemId: courseId,
      itemName: existing.titleEn,
      action: 'unassign',
      changes: {
        employees: { from: employeeIds, to: null },
        remainingCount: {
          from: (existing.assignUsers || []).length,
          to: nextUsers.length,
        },
      },
    });

    return {
      courseId,
      unassignedCount: employeeIds.length,
      remainingCount: nextUsers.length,
    };
  });
}

/**
 * Changes the due date on existing assignments without touching progress,
 * membership or the course's assignees — the safe counterpart to re-running
 * assign (mode 'add' skips existing rows, mode 'replace' is destructive).
 * One audit row per employee whose date actually moved, named
 * `Employee · Course` like the override entries.
 */
export async function updateAssignmentDueDates(
  courseId: string,
  input: { employeeIds: string[]; dueDate: string },
  actor: AuditActor,
): Promise<{
  courseId: string;
  dueDate: string;
  updatedCount: number;
}> {
  const employeeIds = Array.from(new Set(input.employeeIds));

  return db.transaction(async (tx) => {
    const [course] = await tx
      .select({
        id: trainingCourses.id,
        titleEn: trainingCourses.titleEn,
      })
      .from(trainingCourses)
      .where(eq(trainingCourses.id, courseId))
      .limit(1);

    if (!course) {
      throw new ApiError('Training course not found', 404, true, '', {
        code: 'COURSE_NOT_FOUND',
      });
    }

    // Snapshot the rows the UPDATE will touch — the audit entries' "from".
    const beforeRows = await tx
      .select({
        employeeId: trainingCourseAssignments.employeeId,
        dueDate: trainingCourseAssignments.dueDate,
        employeeName: employees.name,
      })
      .from(trainingCourseAssignments)
      .innerJoin(
        employees,
        eq(trainingCourseAssignments.employeeId, employees.id),
      )
      .where(
        and(
          eq(trainingCourseAssignments.courseId, courseId),
          inArray(trainingCourseAssignments.employeeId, employeeIds),
        ),
      );

    if (beforeRows.length === 0) {
      throw new ApiError(
        'No assignments found for the selected employees',
        404,
        true,
        '',
        {
          code: 'ASSIGNMENTS_NOT_FOUND',
        },
      );
    }

    await tx
      .update(trainingCourseAssignments)
      .set({ dueDate: input.dueDate })
      .where(
        and(
          eq(trainingCourseAssignments.courseId, courseId),
          inArray(
            trainingCourseAssignments.employeeId,
            beforeRows.map((row) => row.employeeId),
          ),
        ),
      );

    let updatedCount = 0;
    for (const row of beforeRows) {
      if (row.dueDate === input.dueDate) continue; // Already that date — nothing moved.
      updatedCount += 1;
      await recordAudit({
        actor,
        executor: tx,
        itemType: 'assignment',
        itemId: row.employeeId,
        itemName: `${row.employeeName} · ${course.titleEn}`,
        action: 'update',
        changes: { dueDate: { from: row.dueDate, to: input.dueDate } },
      });
    }

    logger.info(
      `Due date for course "${course.titleEn}" (${courseId}) changed to ${input.dueDate} for ${beforeRows.length} assignments`,
    );

    return {
      courseId,
      dueDate: input.dueDate,
      updatedCount,
    };
  });
}

/**
 * Row shape of the two selects in listCourseAssignments. The catch-branch
 * fallback queries an older schema without the override columns, so those
 * four fields are optional here (the mapper reads them with `?? null`).
 */
type CourseAssignmentRow = {
  id: string;
  courseId: string;
  employeeId: string;
  isRequired: boolean;
  dueDate: string;
  currentChapterId: string | null;
  courseCompletedAt: Date | null;
  assignedAt: Date;
  currentChapterNumber: number | null;
  currentChapterTitleEn: string | null;
  currentChapterTitleEs: string | null;
  employeeName: string;
  employeeEmail: string;
  employeeStatus: EmployeeStatus;
  overrideUntil?: Date | null;
  overriddenBy?: string | null;
  overriddenAt?: Date | null;
  overrideReason?: string | null;
};

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
  let rows: CourseAssignmentRow[];
  try {
    rows = await db
      .select({
        id: trainingCourseAssignments.id,
        courseId: trainingCourseAssignments.courseId,
        employeeId: trainingCourseAssignments.employeeId,
        isRequired: trainingCourseAssignments.isRequired,
        dueDate: trainingCourseAssignments.dueDate,
        currentChapterId: trainingCourseAssignments.currentChapterId,
        courseCompletedAt: trainingCourseAssignments.courseCompletedAt,
        overrideUntil: trainingCourseAssignments.overrideUntil,
        overriddenBy: trainingCourseAssignments.overriddenBy,
        overriddenAt: trainingCourseAssignments.overriddenAt,
        overrideReason: trainingCourseAssignments.overrideReason,
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
  } catch (_err) {
    rows = await db
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
  }

  const [chapterCountRow] = await db
    .select({ chapterCount: count() })
    .from(trainingChapters)
    .where(eq(trainingChapters.courseId, courseId));
  const chapterCount = Number(chapterCountRow?.chapterCount ?? 0);

  return rows.map((r) => {
    const isCompleted = r.courseCompletedAt !== null;
    const dueDateObj = new Date(r.dueDate);
    dueDateObj.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil(
      (dueDateObj.getTime() - todayStart) / (1000 * 60 * 60 * 24),
    );
    const isOverdue = !isCompleted && dueDateObj.getTime() < todayStart;
    const isDueSoon =
      !isCompleted && !isOverdue && diffDays >= 0 && diffDays <= 3;
    const completedChapterCount = isCompleted
      ? chapterCount
      : Math.max((r.currentChapterNumber ?? 1) - 1, 0);

    let status:
      'complete' | 'overdue' | 'due_soon' | 'in_progress' | 'not_started';

    if (isCompleted) {
      status = 'complete';
    } else if (isOverdue) {
      status = 'overdue';
    } else if (isDueSoon) {
      status = 'due_soon';
    } else if (completedChapterCount > 0) {
      status = 'in_progress';
    } else {
      status = 'not_started';
    }

    const isOverridden = Boolean(
      r.overrideUntil && new Date(r.overrideUntil) > new Date() && !isCompleted,
    );

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
      overrideUntil: r.overrideUntil ? r.overrideUntil.toISOString() : null,
      overriddenBy: r.overriddenBy ?? null,
      overriddenAt: r.overriddenAt ? r.overriddenAt.toISOString() : null,
      overrideReason: r.overrideReason ?? null,
      isOverridden,
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

/**
 * Distinct values of one override field across the rows an UPDATE touched.
 * Granting without a courseId hits every required course of the employee and
 * those rows can disagree: one distinct value stays a scalar, several become
 * a list so the entry shows what each row said instead of picking a winner.
 */
function distinctOverrideValues<T extends Date | string | null>(
  values: T[],
): T | T[] | null {
  const uniq = new Map<string, T>();
  for (const v of values) {
    if (v !== undefined) uniq.set(JSON.stringify(v), v);
  }
  const nonNull = [...uniq.values()].filter(
    (v): v is NonNullable<T> => v !== null,
  );
  if (nonNull.length === 1) return nonNull[0] ?? null;
  if (nonNull.length > 1) return nonNull;
  return null;
}

/**
 * Writes the override audit entry for both grant and revoke: item name is
 * `Employee · Course` (or the scope label when no single course is targeted),
 * changes are the override fields read off the rows before the UPDATE ran.
 * Never throws — recordAudit swallows its own failures.
 */
async function recordOverrideAudit(input: {
  actor: AuditActor;
  employeeId: string;
  courseId?: string | undefined;
  /** What follows the employee name when no single course is targeted. */
  scopeLabel: string;
  /** The rows the UPDATE touched, snapshotted before it ran. */
  before: Array<{
    overrideUntil: Date | null;
    overrideReason: string | null;
  }>;
  to: { overrideUntil: Date | null; reason: string | null };
}): Promise<void> {
  const [employee] = await db
    .select({ name: employees.name })
    .from(employees)
    .where(eq(employees.id, input.employeeId))
    .limit(1);

  let scope = input.scopeLabel;
  if (input.courseId) {
    const [course] = await db
      .select({ titleEn: trainingCourses.titleEn })
      .from(trainingCourses)
      .where(eq(trainingCourses.id, input.courseId))
      .limit(1);
    scope = course?.titleEn ?? input.courseId;
  }

  const changes: AuditChanges = {};
  // No rows matched: the attempt still deserves a row, just without
  // before/after values that would claim fields moved when none did.
  if (input.before.length > 0) {
    const fromUntil = distinctOverrideValues(
      input.before.map((r) => r.overrideUntil),
    );
    const fromReason = distinctOverrideValues(
      input.before.map((r) => r.overrideReason),
    );
    if (!isSameValue(fromUntil, input.to.overrideUntil)) {
      changes.overrideUntil = { from: fromUntil, to: input.to.overrideUntil };
    }
    if (!isSameValue(fromReason, input.to.reason)) {
      changes.reason = { from: fromReason, to: input.to.reason };
    }
  }

  const isRevoke = input.to.overrideUntil === null && input.to.reason === null;

  await recordAudit({
    actor: input.actor,
    itemType: 'assignment',
    itemId: input.employeeId,
    itemName: `${employee?.name ?? input.employeeId} · ${scope}`,
    action: isRevoke ? 'revoke_override' : 'override',
    changes: Object.keys(changes).length > 0 ? changes : null,
  });
}

/**
 * Grants a temporary training override to unblock LMS access without marking the course complete.
 */
export async function grantTrainingOverride(params: {
  employeeId: string;
  courseId?: string | undefined;
  managerId: string;
  overrideUntil: string;
  reason?: string | undefined;
  actor: AuditActor;
}) {
  const untilDate = new Date(params.overrideUntil);
  if (isNaN(untilDate.getTime()) || untilDate <= new Date()) {
    throw new ApiError('overrideUntil must be a valid future date/time', 400);
  }

  const conditions = [
    eq(trainingCourseAssignments.employeeId, params.employeeId),
  ];
  if (params.courseId) {
    conditions.push(eq(trainingCourseAssignments.courseId, params.courseId));
  } else {
    conditions.push(eq(trainingCourseAssignments.isRequired, true));
  }

  let managerUuid: string | null = null;
  if (params.managerId) {
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        params.managerId,
      )
    ) {
      managerUuid = params.managerId;
    } else {
      const [emp] = await db
        .select({ id: employees.id })
        .from(employees)
        .where(eq(employees.userId, params.managerId))
        .limit(1);
      if (emp?.id) {
        managerUuid = emp.id;
      }
    }
  }

  // Snapshot the rows the UPDATE will touch — the audit entry's "from".
  const beforeRows = await db
    .select({
      overrideUntil: trainingCourseAssignments.overrideUntil,
      overrideReason: trainingCourseAssignments.overrideReason,
    })
    .from(trainingCourseAssignments)
    .where(and(...conditions));

  await db
    .update(trainingCourseAssignments)
    .set({
      overrideUntil: untilDate,
      overriddenBy: managerUuid,
      overriddenAt: new Date(),
      overrideReason: params.reason || null,
    })
    .where(and(...conditions));

  await recordOverrideAudit({
    actor: params.actor,
    employeeId: params.employeeId,
    courseId: params.courseId,
    scopeLabel: 'all required training',
    before: beforeRows,
    to: { overrideUntil: untilDate, reason: params.reason || null },
  });

  return {
    success: true,
    overrideUntil: untilDate.toISOString(),
    overriddenBy: managerUuid,
    reason: params.reason || null,
  };
}

/**
 * Revokes an active temporary training override.
 */
export async function revokeTrainingOverride(params: {
  employeeId: string;
  courseId?: string | undefined;
  actor: AuditActor;
}) {
  const conditions = [
    eq(trainingCourseAssignments.employeeId, params.employeeId),
  ];
  if (params.courseId) {
    conditions.push(eq(trainingCourseAssignments.courseId, params.courseId));
  }

  // Snapshot before the clear — without a courseId this wipes every
  // assignment row of the employee, which can be many.
  const beforeRows = await db
    .select({
      overrideUntil: trainingCourseAssignments.overrideUntil,
      overrideReason: trainingCourseAssignments.overrideReason,
    })
    .from(trainingCourseAssignments)
    .where(and(...conditions));

  await db
    .update(trainingCourseAssignments)
    .set({
      overrideUntil: null,
      overriddenBy: null,
      overriddenAt: null,
      overrideReason: null,
    })
    .where(and(...conditions));

  await recordOverrideAudit({
    actor: params.actor,
    employeeId: params.employeeId,
    courseId: params.courseId,
    scopeLabel: 'all courses',
    before: beforeRows,
    to: { overrideUntil: null, reason: null },
  });

  return { success: true };
}
