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

export default router;
