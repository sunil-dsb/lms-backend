import express, { type Router } from 'express';
import {
  listCourses,
  getCourse,
  createCourse,
  updateCourse,
  archiveCourse,
  unarchiveCourse,
  deleteCourse,
  assignCourse,
  unassignCourse,
  getMyCourseProgress,
  completeCurrentChapter,
  listMyTraining,
  getMyTrainingCourse,
  getCourseAssignments,
  getTrainingProgress,
  exportTrainingProgress,
  grantTrainingOverride,
  revokeTrainingOverride,
  updateCourseAssignments,
} from '../../controllers/v1/courses.controller.ts';
import { requireAuth } from '../../config/middleware.ts';
import { requireRoles } from '../../shared/middleware/requireRoles.middleware.ts';
import { createLimiter } from '../../shared/middleware/rateLimit.middleware.ts';

const coursesRoute: Router = express.Router();

// Read routes (any authenticated user)
coursesRoute.get('/', requireAuth, listCourses);
coursesRoute.get(
  '/admin/progress/export',
  requireAuth,
  requireRoles(['super_admin', 'manager']),
  exportTrainingProgress,
);
coursesRoute.get(
  '/admin/progress',
  requireAuth,
  requireRoles(['super_admin', 'manager']),
  getTrainingProgress,
);
coursesRoute.post(
  '/admin/override/:employeeId',
  requireAuth,
  requireRoles(['super_admin', 'manager']),
  grantTrainingOverride,
);
coursesRoute.delete(
  '/admin/override/:employeeId',
  requireAuth,
  requireRoles(['super_admin', 'manager']),
  revokeTrainingOverride,
);
coursesRoute.get(
  '/my-training',
  requireAuth,
  requireRoles(['employee', 'manager']),
  listMyTraining,
);
coursesRoute.get(
  '/my-training/:courseId',
  requireAuth,
  requireRoles(['employee', 'manager']),
  getMyTrainingCourse,
);
coursesRoute.get(
  '/:id/assignments',
  requireAuth,
  requireRoles(['super_admin', 'manager']),
  getCourseAssignments,
);
coursesRoute.get('/:id', requireAuth, getCourse);
coursesRoute.get(
  '/:id/progress',
  requireAuth,
  requireRoles(['employee', 'manager']),
  getMyCourseProgress,
);
coursesRoute.post(
  '/:id/chapters/:chapterId/complete',
  requireAuth,
  requireRoles(['employee', 'manager']),
  completeCurrentChapter,
);

// Admin mutation routes (super_admin only)
coursesRoute.post(
  '/',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 30,
    message: 'Too many course creations, please try again later.',
  }),
  createCourse,
);

coursesRoute.post(
  '/:id/assign',
  requireAuth,
  requireRoles(['super_admin']),
  assignCourse,
);

coursesRoute.post(
  '/:id/unassign',
  requireAuth,
  requireRoles(['super_admin']),
  unassignCourse,
);

coursesRoute.patch(
  '/:id/assignments',
  requireAuth,
  requireRoles(['super_admin']),
  updateCourseAssignments,
);

coursesRoute.patch(
  '/:id',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 60,
    message: 'Too many course updates, please try again later.',
  }),
  updateCourse,
);

coursesRoute.post(
  '/:id/archive',
  requireAuth,
  requireRoles(['super_admin']),
  archiveCourse,
);

coursesRoute.post(
  '/:id/unarchive',
  requireAuth,
  requireRoles(['super_admin']),
  unarchiveCourse,
);

coursesRoute.delete(
  '/:id',
  requireAuth,
  requireRoles(['super_admin']),
  deleteCourse,
);

export default coursesRoute;
