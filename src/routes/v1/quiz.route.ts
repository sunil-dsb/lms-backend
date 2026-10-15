import express, { type Router } from 'express';
import {
  createQuiz,
  getQuiz,
  listQuizzes,
  updateQuiz,
  deleteQuiz,
} from '../../controllers/v1/quiz.controller.ts';
import { requireAuth } from '../../config/middleware.ts';
import { requireRoles } from '../../shared/middleware/requireRoles.middleware.ts';

const quizRoute: Router = express.Router();

// Public read routes (any logged-in employee)
quizRoute.get('/', requireAuth, listQuizzes);
quizRoute.get('/:id', requireAuth, getQuiz);

// Admin routes
quizRoute.post('/', requireAuth, requireRoles(['super_admin']), createQuiz);
quizRoute.put('/:id', requireAuth, requireRoles(['super_admin']), updateQuiz);
quizRoute.delete(
  '/:id',
  requireAuth,
  requireRoles(['super_admin']),
  deleteQuiz,
);

export default quizRoute;
