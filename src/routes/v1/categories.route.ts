import express, { type Router } from 'express';
import {
  listCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
  archiveCategory,
  unarchiveCategory,
} from '../../controllers/v1/categories.controller.ts';
import { requireAuth } from '../../config/middleware.ts';
import { requireRoles } from '../../shared/middleware/requireRoles.middleware.ts';

import {
  listSubcategories,
  listSubcategoriesAdmin,
  createSubcategoryAdmin,
  updateSubcategoryAdmin,
  deleteSubcategoryAdmin,
  archiveSubcategoryAdmin,
  unarchiveSubcategoryAdmin,
} from '../../controllers/v1/subcategories.controller.ts';

import { createLimiter } from '../../shared/middleware/rateLimit.middleware.ts';

const categoriesRoute: Router = express.Router();

// Public read route (any logged-in employee)
categoriesRoute.get('/', requireAuth, listCategories);

// Admin routes for Categories
categoriesRoute.post(
  '/',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 20,
    message: 'Too many categories created, please try again later.',
  }),
  createCategory,
);
categoriesRoute.patch(
  '/:id',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 30,
    message: 'Too many category updates, please try again later.',
  }),
  updateCategory,
);
categoriesRoute.delete(
  '/:id',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 20,
    message: 'Too many category deletions, please try again later.',
  }),
  deleteCategory,
);
categoriesRoute.post(
  '/:id/archive',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 20,
    message: 'Too many category archive requests, please try again later.',
  }),
  archiveCategory,
);
categoriesRoute.post(
  '/:id/unarchive',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 20,
    message: 'Too many category unarchive requests, please try again later.',
  }),
  unarchiveCategory,
);

// Subcategories list (all subcategories, optional ?categoryId=)
categoriesRoute.get('/subcategories', requireAuth, listSubcategories);

// Single category read route
categoriesRoute.get('/:id', requireAuth, getCategory);

// Admin routes for Subcategories
categoriesRoute.get(
  '/:categoryId/subcategories',
  requireAuth,
  listSubcategoriesAdmin,
);
categoriesRoute.post(
  '/:categoryId/subcategories',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 20,
    message: 'Too many subcategories created, please try again later.',
  }),
  createSubcategoryAdmin,
);
categoriesRoute.patch(
  '/:categoryId/subcategories/:id',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 30,
    message: 'Too many subcategory updates, please try again later.',
  }),
  updateSubcategoryAdmin,
);
categoriesRoute.post(
  '/:categoryId/subcategories/:id/archive',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 20,
    message: 'Too many subcategory archive requests, please try again later.',
  }),
  archiveSubcategoryAdmin,
);
categoriesRoute.post(
  '/:categoryId/subcategories/:id/unarchive',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 20,
    message: 'Too many subcategory unarchive requests, please try again later.',
  }),
  unarchiveSubcategoryAdmin,
);
categoriesRoute.delete(
  '/:categoryId/subcategories/:id',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 20,
    message: 'Too many subcategory deletions, please try again later.',
  }),
  deleteSubcategoryAdmin,
);

export default categoriesRoute;
