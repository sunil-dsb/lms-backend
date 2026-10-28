import express, { type Router } from 'express';
import config from '../../config/index.ts';
import authRoute from './auth.route.ts';
import employeesRoute from './employees.route.ts';
import proceduresRoute from './procedures.route.ts';
import uploadsRoute from './uploads.route.ts';
import stationsRoute from './stations.route.ts';
import locationsRoute from './locations.route.ts';
import jobsRoute from './jobs.route.ts';
import categoriesRoute from './categories.route.ts';
import subcategoriesRoute from './subcategories.route.ts';
import quizzesRoute from './quiz.route.ts';
import coursesRoute from './courses.route.ts';
import chaptersRoute from './chapters.route.ts';
import { importProcedure } from '../../controllers/v1/procedures.controller.ts';
import { requireAuth } from '../../config/middleware.ts';
import { requireRoles } from '../../shared/middleware/requireRoles.middleware.ts';
import { createLimiter } from '../../shared/middleware/rateLimit.middleware.ts';
import { documentUpload } from '../../shared/middleware/upload.middleware.ts';

const router: Router = express.Router();

const defaultRoutes = [
  {
    path: '/auth',
    route: authRoute,
  },

  {
    path: '/employees',
    route: employeesRoute,
  },
  {
    path: '/uploads',
    route: uploadsRoute,
  },
  {
    path: '/stations',
    route: stationsRoute,
  },
  {
    path: '/locations',
    route: locationsRoute,
  },
  {
    path: '/jobs',
    route: jobsRoute,
  },
  {
    path: '/categories',
    route: categoriesRoute,
  },
  {
    path: '/procedures',
    route: proceduresRoute,
  },
  {
    path: '/quizzes',
    route: quizzesRoute,
  },
  {
    path: '/subcategories',
    route: subcategoriesRoute,
  },
  {
    path: '/courses',
    route: coursesRoute,
  },
  {
    path: '/chapters',
    route: chaptersRoute,
  },
  {
    path: '/courses/:courseId/chapters',
    route: chaptersRoute,
  },
];

const devRoutes: { path: string; route: Router }[] = [];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

if (config.env === 'development') {
  devRoutes.forEach((route) => {
    router.use(route.path, route.route);
  });
}

// Alias route: POST /api/v1/import/procedures
router.post(
  '/import/procedures',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 20,
    message: 'Too many procedure import requests, please try again later.',
  }),
  documentUpload.single('file'),
  importProcedure,
);

export default router;
