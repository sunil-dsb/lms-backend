import express, { type Router } from 'express';
import {
  listCourses,
  getCourse,
  createCourse,
  updateCourse,
  archiveCourse,
  unarchiveCourse,
  deleteCourse,
} from '../../controllers/v1/courses.controller.ts';
import { requireAuth } from '../../config/middleware.ts';
import { requireRoles } from '../../shared/middleware/requireRoles.middleware.ts';
import { createLimiter } from '../../shared/middleware/rateLimit.middleware.ts';

const coursesRoute: Router = express.Router();

// Read routes (any authenticated user)
coursesRoute.get('/', requireAuth, listCourses);
coursesRoute.get('/:id', requireAuth, getCourse);

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

coursesRoute.put(
  '/:id',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 60,
    message: 'Too many course updates, please try again later.',
  }),
  updateCourse,
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
