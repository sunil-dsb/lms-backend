import express, { type Router } from 'express';
import {
  listSubcategories,
  getSubcategory,
  archiveSubcategoryAdmin,
  unarchiveSubcategoryAdmin,
} from '../../controllers/v1/subcategories.controller.ts';
import { requireAuth } from '../../config/middleware.ts';
import { requireRoles } from '../../shared/middleware/requireRoles.middleware.ts';
import { createLimiter } from '../../shared/middleware/rateLimit.middleware.ts';

const subcategoriesRoute: Router = express.Router();

// Public read routes for subcategories (any logged-in employee)
subcategoriesRoute.get('/', requireAuth, listSubcategories);
subcategoriesRoute.get('/:id', requireAuth, getSubcategory);

// Admin archive/unarchive routes
subcategoriesRoute.post(
  '/:id/archive',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 20,
    message: 'Too many subcategory archive requests, please try again later.',
  }),
  archiveSubcategoryAdmin,
);
subcategoriesRoute.post(
  '/:id/unarchive',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 20,
    message: 'Too many subcategory unarchive requests, please try again later.',
  }),
  unarchiveSubcategoryAdmin,
);

export default subcategoriesRoute;
