import express, { type Router } from 'express';
import {
  listChapters,
  getChapter,
  deleteChapter,
  reorderChapters,
} from '../../controllers/v1/chapters.controller.ts';
import { requireAuth } from '../../config/middleware.ts';
import { requireRoles } from '../../shared/middleware/requireRoles.middleware.ts';

const chaptersRoute: Router = express.Router({ mergeParams: true });

// Read routes
chaptersRoute.get('/', requireAuth, listChapters);
chaptersRoute.get('/:id', requireAuth, getChapter);

// Admin mutation routes (super_admin only)
chaptersRoute.patch(
  '/reorder',
  requireAuth,
  requireRoles(['super_admin']),
  reorderChapters,
);

chaptersRoute.delete(
  '/:id',
  requireAuth,
  requireRoles(['super_admin']),
  deleteChapter,
);

export default chaptersRoute;
