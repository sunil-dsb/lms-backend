import ApiError from '../../shared/utils/ApiError.ts';
import { and, asc, eq, gt } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  employees,
  stations,
  trainingChapters,
  trainingCourseAssignments,
  trainingCourses,
} from '../../db/index.ts';

export async function getCourseProgress(courseId: string, employeeId: string) {
  const [assignment] = await db
    .select({
      courseId: trainingCourseAssignments.courseId,
      employeeId: trainingCourseAssignments.employeeId,
      dueDate: trainingCourseAssignments.dueDate,
      assignedAt: trainingCourseAssignments.assignedAt,
      currentChapterId: trainingCourseAssignments.currentChapterId,
      currentChapterNumber: trainingChapters.number,
      currentChapterTitleEn: trainingChapters.titleEn,
      currentChapterTitleEs: trainingChapters.titleEs,
      courseCompletedAt: trainingCourseAssignments.courseCompletedAt,
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
        eq(trainingCourseAssignments.courseId, courseId),
        eq(trainingCourseAssignments.employeeId, employeeId),
        eq(trainingCourses.status, 'published'),
      ),
    )
    .limit(1);

  if (!assignment) {
    throw new ApiError('Course assignment not found', 404, true, '', {
      code: 'COURSE_ASSIGNMENT_NOT_FOUND',
    });
  }

  return assignment;
}

/** Records quiz completion for the current chapter and advances one chapter. */
export async function completeCurrentChapter(
  courseId: string,
  chapterId: string,
  employeeId: string,
) {
  return db.transaction(async (tx) => {
    const [assignment] = await tx
      .select({
        currentChapterId: trainingCourseAssignments.currentChapterId,
        courseCompletedAt: trainingCourseAssignments.courseCompletedAt,
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

    if (!assignment) {
      throw new ApiError('Course assignment not found', 404, true, '', {
        code: 'COURSE_ASSIGNMENT_NOT_FOUND',
      });
    }
    if (assignment.courseCompletedAt || !assignment.currentChapterId) {
      throw new ApiError('Course is already complete', 409, true, '', {
        code: 'COURSE_ALREADY_COMPLETE',
      });
    }
    if (assignment.currentChapterId !== chapterId) {
      throw new ApiError('This is not the current chapter', 409, true, '', {
        code: 'CHAPTER_NOT_IN_PROGRESS',
      });
    }

    const [currentChapter] = await tx
      .select({
        number: trainingChapters.number,
        quizId: trainingChapters.quizId,
      })
      .from(trainingChapters)
      .where(
        and(
          eq(trainingChapters.id, chapterId),
          eq(trainingChapters.courseId, courseId),
        ),
      )
      .limit(1);
    if (!currentChapter) {
      throw new ApiError('Course chapter not found', 404, true, '', {
        code: 'CHAPTER_NOT_FOUND',
      });
    }
    // Chapter completion advances progress whether quiz was required or not

    const [nextChapter] = await tx
      .select({ id: trainingChapters.id })
      .from(trainingChapters)
      .where(
        and(
          eq(trainingChapters.courseId, courseId),
          gt(trainingChapters.number, currentChapter.number),
        ),
      )
      .orderBy(asc(trainingChapters.number))
      .limit(1);

    const completedAt = new Date();
    await tx
      .update(trainingCourseAssignments)
      .set({
        currentChapterId: nextChapter?.id ?? null,
        courseCompletedAt: nextChapter ? null : completedAt,
      })
      .where(
        and(
          eq(trainingCourseAssignments.courseId, courseId),
          eq(trainingCourseAssignments.employeeId, employeeId),
          eq(trainingCourseAssignments.currentChapterId, chapterId),
        ),
      );

    return {
      courseId,
      completedChapterId: chapterId,
      currentChapterId: nextChapter?.id ?? null,
      courseCompletedAt: nextChapter ? null : completedAt,
    };
  });
}

/**
 * Aggregated training progress for Admin Progress tab (`/admin/training/progress`).
 */
export async function getTrainingProgress() {
  const todayStart = new Date().setHours(0, 0, 0, 0);

  const rows = await db
    .select({
      id: trainingCourseAssignments.id,
      courseId: trainingCourseAssignments.courseId,
      courseTitleEn: trainingCourses.titleEn,
      courseTitleEs: trainingCourses.titleEs,
      employeeId: trainingCourseAssignments.employeeId,
      employeeName: employees.name,
      stationIds: employees.stationIds,
      dueDate: trainingCourseAssignments.dueDate,
      currentChapterId: trainingCourseAssignments.currentChapterId,
      currentChapterNumber: trainingChapters.number,
      courseCompletedAt: trainingCourseAssignments.courseCompletedAt,
      assignedAt: trainingCourseAssignments.assignedAt,
    })
    .from(trainingCourseAssignments)
    .innerJoin(
      trainingCourses,
      eq(trainingCourseAssignments.courseId, trainingCourses.id),
    )
    .innerJoin(
      employees,
      eq(trainingCourseAssignments.employeeId, employees.id),
    )
    .leftJoin(
      trainingChapters,
      eq(trainingCourseAssignments.currentChapterId, trainingChapters.id),
    );

  const allStations = await db
    .select({ id: stations.id, name: stations.name })
    .from(stations);
  const stationNameMap = new Map(allStations.map((s) => [s.id, s.name]));

  let completed = 0;
  let inProgress = 0;
  let overdue = 0;

  const employeeMap = new Map<
    string,
    {
      employeeId: string;
      name: string;
      station: string;
      coursesDone: number;
      coursesTotal: number;
      assignments: Array<{
        course: { id: string; titleEn: string; titleEs: string };
        dueDate: string;
        currentChapter: number | null;
        isComplete: boolean;
        isOverdue: boolean;
        courseCompletedAt: string | null;
      }>;
    }
  >();

  const courseMap = new Map<
    string,
    {
      course: { id: string; titleEn: string; titleEs: string };
      peopleDone: number;
      peopleTotal: number;
      activeChapters: number[];
      hasOverdue: boolean;
    }
  >();

  for (const r of rows) {
    const isComplete = r.courseCompletedAt !== null;
    const isOverdue = !isComplete && new Date(r.dueDate).getTime() < todayStart;

    if (isComplete) {
      completed++;
    } else if (isOverdue) {
      overdue++;
    } else {
      inProgress++;
    }

    let empEntry = employeeMap.get(r.employeeId);
    if (!empEntry) {
      const primaryStationId = r.stationIds?.[0];
      const stationName =
        (primaryStationId && stationNameMap.get(primaryStationId)) || 'General';
      empEntry = {
        employeeId: r.employeeId,
        name: r.employeeName,
        station: stationName,
        coursesDone: 0,
        coursesTotal: 0,
        assignments: [],
      };
      employeeMap.set(r.employeeId, empEntry);
    }
    empEntry.coursesTotal++;
    if (isComplete) empEntry.coursesDone++;
    empEntry.assignments.push({
      course: {
        id: r.courseId,
        titleEn: r.courseTitleEn,
        titleEs: r.courseTitleEs,
      },
      dueDate: r.dueDate,
      currentChapter: r.currentChapterNumber,
      isComplete,
      isOverdue,
      courseCompletedAt: r.courseCompletedAt
        ? r.courseCompletedAt.toISOString()
        : null,
    });

    let courseEntry = courseMap.get(r.courseId);
    if (!courseEntry) {
      courseEntry = {
        course: {
          id: r.courseId,
          titleEn: r.courseTitleEn,
          titleEs: r.courseTitleEs,
        },
        peopleDone: 0,
        peopleTotal: 0,
        activeChapters: [],
        hasOverdue: false,
      };
      courseMap.set(r.courseId, courseEntry);
    }
    courseEntry.peopleTotal++;
    if (isComplete) {
      courseEntry.peopleDone++;
    } else {
      if (r.currentChapterNumber) {
        courseEntry.activeChapters.push(r.currentChapterNumber);
      }
      if (isOverdue) courseEntry.hasOverdue = true;
    }
  }

  const employeesList = Array.from(employeeMap.values()).map((emp) => {
    const unfinished = emp.assignments
      .filter((a) => !a.isComplete)
      .sort(
        (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime(),
      );

    const current = unfinished[0] || null;
    const hasOverdue = emp.assignments.some((a) => a.isOverdue);
    const allDone =
      emp.coursesTotal > 0 && emp.coursesDone === emp.coursesTotal;

    const status: 'complete' | 'in_progress' | 'overdue' = allDone
      ? 'complete'
      : hasOverdue
        ? 'overdue'
        : 'in_progress';

    return {
      employeeId: emp.employeeId,
      name: emp.name,
      station: emp.station,
      coursesDone: emp.coursesDone,
      coursesTotal: emp.coursesTotal,
      currentCourse: current ? current.course : null,
      currentChapter: current ? current.currentChapter : null,
      status,
      // Per-assignment detail for drill-downs and the admin home card — the
      // Progress table ignores it, but the dashboard groups by person/week
      // (overdue, due this week) which needs every assignment's due date.
      assignments: emp.assignments,
    };
  });

  const coursesList = Array.from(courseMap.values()).map((c) => {
    const allDone = c.peopleTotal > 0 && c.peopleDone === c.peopleTotal;
    const status: 'complete' | 'in_progress' | 'overdue' = allDone
      ? 'complete'
      : c.hasOverdue
        ? 'overdue'
        : 'in_progress';

    const currentChapter =
      c.activeChapters.length > 0 ? Math.min(...c.activeChapters) : null;

    return {
      course: c.course,
      peopleDone: c.peopleDone,
      peopleTotal: c.peopleTotal,
      currentChapter,
      status,
    };
  });

  return {
    summary: {
      completed,
      inProgress,
      overdue,
    },
    employees: employeesList,
    courses: coursesList,
  };
}
