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
import { getEmployeeRequiredTrainingStatus } from './course-assignments.service.ts';

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
      isRequired: trainingCourseAssignments.isRequired,
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

  if (!assignment.isRequired) {
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

    if (!assignment) {
      throw new ApiError('Course assignment not found', 404, true, '', {
        code: 'COURSE_ASSIGNMENT_NOT_FOUND',
      });
    }
    if (!assignment.isRequired) {
      const requiredAssignments = await tx
        .select({
          courseCompletedAt: trainingCourseAssignments.courseCompletedAt,
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
      const requiredTraining = {
        requiredCount: requiredAssignments.length,
        completedCount: requiredAssignments.filter(
          (item) => item.courseCompletedAt !== null,
        ).length,
      };
      if (requiredTraining.requiredCount !== requiredTraining.completedCount) {
        throw new ApiError(
          'Complete required training before opening other courses',
          403,
          true,
          '',
          {
            code: 'COURSE_LOCKED_BY_REQUIRED_TRAINING',
            details: {
              ...requiredTraining,
              isComplete: false,
            },
          },
        );
      }
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
export interface TrainingProgressOptions {
  status?: 'complete' | 'in_progress' | 'overdue';
  groupBy?: 'employee' | 'course';
  page?: number;
  limit?: number;
  search?: string;
  includeAssignments?: boolean;
}

export async function getTrainingProgress(
  options: TrainingProgressOptions = {},
) {
  const todayStart = new Date().setHours(0, 0, 0, 0);

  const rows = await db
    .select({
      courseId: trainingCourseAssignments.courseId,
      courseTitleEn: trainingCourses.titleEn,
      courseTitleEs: trainingCourses.titleEs,
      employeeId: trainingCourseAssignments.employeeId,
      employeeName: employees.name,
      stationIds: employees.stationIds,
      dueDate: trainingCourseAssignments.dueDate,
      currentChapterNumber: trainingChapters.number,
      courseCompletedAt: trainingCourseAssignments.courseCompletedAt,
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
    )
    // Match the employee drill-down, which shows published courses only.
    .where(eq(trainingCourses.status, 'published'));

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
      currentChapter: number | null;
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
        currentChapter: null,
        hasOverdue: false,
      };
      courseMap.set(r.courseId, courseEntry);
    }
    courseEntry.peopleTotal++;
    if (isComplete) {
      courseEntry.peopleDone++;
    } else {
      if (r.currentChapterNumber) {
        courseEntry.currentChapter =
          courseEntry.currentChapter === null
            ? r.currentChapterNumber
            : Math.min(courseEntry.currentChapter, r.currentChapterNumber);
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
      ...(options.includeAssignments
        ? {
            assignments: emp.assignments.map((assignment) => ({
              courseId: assignment.course.id,
              courseTitleEn: assignment.course.titleEn,
              courseTitleEs: assignment.course.titleEs,
              dueDate: assignment.dueDate,
              isComplete: assignment.isComplete,
              isOverdue: assignment.isOverdue,
              courseCompletedAt: assignment.courseCompletedAt,
            })),
          }
        : {}),
    };
  });

  const coursesList = Array.from(courseMap.values()).map((c) => {
    const allDone = c.peopleTotal > 0 && c.peopleDone === c.peopleTotal;
    const status: 'complete' | 'in_progress' | 'overdue' = allDone
      ? 'complete'
      : c.hasOverdue
        ? 'overdue'
        : 'in_progress';

    return {
      course: c.course,
      peopleDone: c.peopleDone,
      peopleTotal: c.peopleTotal,
      currentChapter: c.currentChapter,
      status,
    };
  });

  let filteredEmployees = options.status
    ? employeesList.filter((employee) => employee.status === options.status)
    : employeesList;
  let filteredCourses = options.status
    ? coursesList.filter((course) => course.status === options.status)
    : coursesList;

  // Group tab counts reflect the selected status, independent of the search
  // term and current page. Pagination totals below still include search.
  const counts = {
    employees: filteredEmployees.length,
    courses: filteredCourses.length,
  };

  const search = options.search?.trim().toLocaleLowerCase();
  if (search) {
    filteredEmployees = filteredEmployees.filter((employee) =>
      employee.name.toLocaleLowerCase().includes(search),
    );
    filteredCourses = filteredCourses.filter((course) =>
      `${course.course.titleEn} ${course.course.titleEs}`
        .toLocaleLowerCase()
        .includes(search),
    );
  }

  let pagination:
    | { page: number; limit: number; total: number; totalPages: number }
    | undefined;
  if (options.groupBy) {
    const page = options.page ?? 1;
    const limit = options.limit ?? 25;
    const rows =
      options.groupBy === 'employee' ? filteredEmployees : filteredCourses;
    const totalPages = Math.ceil(rows.length / limit);
    const currentPage = totalPages === 0 ? 1 : Math.min(page, totalPages);
    pagination = {
      page: currentPage,
      limit,
      total: rows.length,
      totalPages,
    };
    const start = (currentPage - 1) * limit;
    if (options.groupBy === 'employee') {
      filteredEmployees = filteredEmployees.slice(start, start + limit);
      filteredCourses = [];
    } else {
      filteredCourses = filteredCourses.slice(start, start + limit);
      filteredEmployees = [];
    }
  }

  return {
    summary: {
      completed,
      inProgress,
      overdue,
    },
    counts,
    employees: filteredEmployees,
    courses: filteredCourses,
    ...(pagination ? { pagination } : {}),
  };
}
