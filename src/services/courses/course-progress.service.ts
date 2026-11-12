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
  status?:
    | 'complete'
    | 'in_progress'
    | 'overdue'
    | 'not_started'
    | 'due_soon'
    | 'restricted';
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
      employeeEmail: employees.email,
      stationIds: employees.stationIds,
      isRequired: trainingCourseAssignments.isRequired,
      dueDate: trainingCourseAssignments.dueDate,
      currentChapterNumber: trainingChapters.number,
      courseCompletedAt: trainingCourseAssignments.courseCompletedAt,
      overrideUntil: trainingCourseAssignments.overrideUntil,
      overrideReason: trainingCourseAssignments.overrideReason,
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
  let notStarted = 0;
  let dueSoon = 0;

  const employeeMap = new Map<
    string,
    {
      employeeId: string;
      name: string;
      email: string | null;
      station: string;
      coursesDone: number;
      coursesTotal: number;
      requiredDone: number;
      requiredTotal: number;
      assignments: Array<{
        course: { id: string; titleEn: string; titleEs: string };
        dueDate: string;
        currentChapter: number | null;
        isComplete: boolean;
        isOverdue: boolean;
        isDueSoon: boolean;
        isStarted: boolean;
        isRequired: boolean;
        isOverridden: boolean;
        overrideUntil: string | null;
        overrideReason: string | null;
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
      hasDueSoon: boolean;
      hasStarted: boolean;
    }
  >();

  for (const r of rows) {
    const isComplete = r.courseCompletedAt !== null;
    const dueDateObj = new Date(r.dueDate);
    dueDateObj.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil(
      (dueDateObj.getTime() - todayStart) / (1000 * 60 * 60 * 24),
    );
    const isOverdue = !isComplete && dueDateObj.getTime() < todayStart;
    const isDueSoon =
      !isComplete && !isOverdue && diffDays >= 0 && diffDays <= 3;
    const isStarted = !isComplete && (r.currentChapterNumber ?? 1) > 1;

    const isOverridden = Boolean(
      r.overrideUntil && new Date(r.overrideUntil) > new Date() && !isComplete,
    );

    if (isComplete) {
      completed++;
    } else if (isOverdue) {
      overdue++;
    } else if (isDueSoon) {
      dueSoon++;
    } else if (isStarted) {
      inProgress++;
    } else {
      notStarted++;
    }

    let empEntry = employeeMap.get(r.employeeId);
    if (!empEntry) {
      const primaryStationId = r.stationIds?.[0];
      const stationName =
        (primaryStationId && stationNameMap.get(primaryStationId)) || 'General';
      empEntry = {
        employeeId: r.employeeId,
        name: r.employeeName,
        email: r.employeeEmail,
        station: stationName,
        coursesDone: 0,
        coursesTotal: 0,
        requiredDone: 0,
        requiredTotal: 0,
        assignments: [],
      };
      employeeMap.set(r.employeeId, empEntry);
    }
    empEntry.coursesTotal++;
    if (isComplete) empEntry.coursesDone++;
    if (r.isRequired) {
      empEntry.requiredTotal++;
      if (isComplete) empEntry.requiredDone++;
    }

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
      isDueSoon,
      isStarted,
      isRequired: r.isRequired,
      isOverridden,
      overrideUntil: r.overrideUntil ? r.overrideUntil.toISOString() : null,
      overrideReason: r.overrideReason ?? null,
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
        hasDueSoon: false,
        hasStarted: false,
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
      if (isDueSoon) courseEntry.hasDueSoon = true;
      if (isStarted) courseEntry.hasStarted = true;
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
    const hasDueSoon = emp.assignments.some((a) => a.isDueSoon);
    const hasStarted = emp.assignments.some((a) => a.isStarted);
    const allDone =
      emp.coursesTotal > 0 && emp.coursesDone === emp.coursesTotal;

    const isRestricted = emp.assignments.some(
      (a) => a.isRequired && a.isOverdue && !a.isOverridden,
    );
    const isOverridden =
      !isRestricted &&
      emp.assignments.some(
        (a) => a.isRequired && a.isOverdue && a.isOverridden,
      );

    const status:
      | 'complete'
      | 'in_progress'
      | 'overdue'
      | 'not_started'
      | 'due_soon'
      | 'restricted' = isRestricted
      ? 'restricted'
      : allDone
        ? 'complete'
        : hasOverdue
          ? 'overdue'
          : hasDueSoon
            ? 'due_soon'
            : hasStarted
              ? 'in_progress'
              : 'not_started';

    return {
      employeeId: emp.employeeId,
      name: emp.name,
      email: emp.email,
      station: emp.station,
      coursesDone: emp.coursesDone,
      coursesTotal: emp.coursesTotal,
      requiredCoursesDone: emp.requiredDone,
      requiredCoursesTotal: emp.requiredTotal,
      isRestricted,
      isOverridden,
      hasOverdue,
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
              isDueSoon: assignment.isDueSoon,
              isStarted: assignment.isStarted,
              isRequired: assignment.isRequired,
              isOverridden: assignment.isOverridden,
              courseCompletedAt: assignment.courseCompletedAt,
            })),
          }
        : {}),
    };
  });

  const coursesList = Array.from(courseMap.values()).map((c) => {
    const allDone = c.peopleTotal > 0 && c.peopleDone === c.peopleTotal;
    const status:
      'complete' | 'in_progress' | 'overdue' | 'not_started' | 'due_soon' =
      allDone
        ? 'complete'
        : c.hasOverdue
          ? 'overdue'
          : c.hasDueSoon
            ? 'due_soon'
            : c.hasStarted
              ? 'in_progress'
              : 'not_started';

    return {
      course: c.course,
      peopleDone: c.peopleDone,
      peopleTotal: c.peopleTotal,
      currentChapter: c.currentChapter,
      status,
    };
  });

  const restricted = employeesList.filter((e) => e.isRestricted).length;

  let filteredEmployees = options.status
    ? options.status === 'restricted'
      ? employeesList.filter((employee) => employee.isRestricted)
      : options.status === 'overdue'
        ? employeesList.filter(
            (employee) =>
              employee.status === 'overdue' ||
              employee.isRestricted ||
              employee.hasOverdue,
          )
        : employeesList.filter((employee) => employee.status === options.status)
    : employeesList;
  let filteredCourses = options.status
    ? options.status === 'restricted'
      ? []
      : coursesList.filter((course) => course.status === options.status)
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
    const limit = options.limit ?? 10;
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
      notStarted,
      dueSoon,
      restricted,
    },
    counts,
    employees: filteredEmployees,
    courses: filteredCourses,
    ...(pagination ? { pagination } : {}),
  };
}

/**
 * Generates an RFC-4180 compliant CSV string representing the training & compliance progress.
 */
export async function exportTrainingProgressCsv(
  options: TrainingProgressOptions = {},
): Promise<string> {
  const exportOpts: TrainingProgressOptions = {
    includeAssignments: true,
  };
  if (options.status) exportOpts.status = options.status;
  if (options.groupBy) exportOpts.groupBy = options.groupBy;
  if (options.search) exportOpts.search = options.search;

  // Retrieve unpaginated progress dataset with assignments included
  const progress = await getTrainingProgress(exportOpts);

  const escapeCsv = (val: unknown): string => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const lines: string[] = [];

  if (options.groupBy === 'course') {
    lines.push(
      [
        'Course Name (EN)',
        'Course Name (ES)',
        'People Completed',
        'People Assigned',
        'Status',
      ]
        .map(escapeCsv)
        .join(','),
    );
    for (const c of progress.courses) {
      lines.push(
        [
          c.course.titleEn,
          c.course.titleEs,
          c.peopleDone,
          c.peopleTotal,
          c.status,
        ]
          .map(escapeCsv)
          .join(','),
      );
    }
  } else {
    lines.push(
      [
        'Employee Name',
        'Email',
        'Station',
        'Compliance Status',
        'Is Restricted (Locked)',
        'Active Manager Override',
        'Required Courses Completed',
        'Required Courses Total',
        'All Courses Completed',
        'All Courses Total',
        'Overdue Courses',
      ]
        .map(escapeCsv)
        .join(','),
    );

    for (const e of progress.employees) {
      const overdueTitles = (e.assignments || [])
        .filter((a) => a.isOverdue)
        .map((a) => a.courseTitleEn)
        .join('; ');

      lines.push(
        [
          e.name,
          e.email || '',
          e.station,
          e.status,
          e.isRestricted ? 'YES' : 'NO',
          e.isOverridden ? 'YES' : 'NO',
          e.requiredCoursesDone ?? 0,
          e.requiredCoursesTotal ?? 0,
          e.coursesDone,
          e.coursesTotal,
          overdueTitles,
        ]
          .map(escapeCsv)
          .join(','),
      );
    }
  }

  return lines.join('\r\n');
}
