import type { Request, Response } from 'express';
import ApiResponse from '../../shared/utils/ApiResponse.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import catchAsync from '../../shared/utils/catchAsync.ts';
import { idParam } from '../../shared/validations/employees.schema.ts';
import { db } from '../../db/client.ts';
import { employees } from '../../db/index.ts';
import { eq } from 'drizzle-orm';
import { listEmployeeTraining } from '../../services/courses/course-assignments.service.ts';

// ---------- GET /api/admin/employees/:id/training --------------------------
// Every training course assigned to this employee, with its current state.
// Reuses the same assignment query the employee-side "my training" list is
// built on, but addressed by employee id in the URL so admins can fetch it
// for anyone (employees route is already super_admin-gated).
export const getEmployeeTraining = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const param = idParam.safeParse(req.params);
    if (!param.success) {
      throw new ApiError('Invalid employee id', 400, true, '', {
        code: 'INVALID_INPUT',
      });
    }

    const [employee] = await db
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      .where(eq(employees.id, param.data.id))
      .limit(1);
    if (!employee) {
      throw new ApiError('Employee not found', 404, true, '', {
        code: 'EMPLOYEE_NOT_FOUND',
      });
    }

    const rows = await listEmployeeTraining(param.data.id);

    const todayStart = new Date().setHours(0, 0, 0, 0);
    const assignments = rows.map((r) => {
      const completed = r.courseCompletedAt !== null;
      const isOverdue =
        !completed && new Date(r.dueDate).getTime() < todayStart;
      const status = completed
        ? 'complete'
        : isOverdue
          ? 'overdue'
          : r.completedChapterCount > 0
            ? 'in_progress'
            : 'due';

      return {
        assignmentId: r.assignmentId,
        courseId: r.courseId,
        titleEn: r.titleEn,
        titleEs: r.titleEs,
        purposeEn: r.purposeEn,
        purposeEs: r.purposeEs,
        courseStatus: r.courseStatus,
        isRequired: r.isRequired,
        dueDate: r.dueDate,
        assignedAt: r.assignedAt.toISOString(),
        currentChapterId: r.currentChapterId,
        currentChapterNumber: r.currentChapterNumber,
        currentChapterTitleEn: r.currentChapterTitleEn,
        currentChapterTitleEs: r.currentChapterTitleEs,
        courseCompletedAt: r.courseCompletedAt
          ? r.courseCompletedAt.toISOString()
          : null,
        chapterCount: r.chapterCount,
        completedChapterCount: r.completedChapterCount,
        progressPercent: r.progressPercent,
        status: r.status || status,
        overrideUntil: r.overrideUntil ?? null,
        overriddenBy: r.overriddenBy ?? null,
        overriddenAt: r.overriddenAt ?? null,
        overrideReason: r.overrideReason ?? null,
        isOverridden: r.isOverridden ?? false,
      };
    });

    res.status(200).json(
      ApiResponse.success('Employee training retrieved successfully', {
        employee: { id: employee.id, name: employee.name },
        assignments,
      }),
    );
  },
);
