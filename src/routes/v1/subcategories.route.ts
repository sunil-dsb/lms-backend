import express, { type Router } from 'express';
import {
  listSubcategories,
  getSubcategory,
} from '../../controllers/v1/subcategories.controller.ts';
import { requireAuth } from '../../config/middleware.ts';

const subcategoriesRoute: Router = express.Router();

// Public read routes for subcategories (any logged-in employee)
subcategoriesRoute.get('/', requireAuth, listSubcategories);
subcategoriesRoute.get('/:id', requireAuth, getSubcategory);

export default subcategoriesRoute;
