import express, { type Router } from 'express';
import {
  createQuiz,
  getQuiz,
  listQuizzes,
  updateQuiz,
  deleteQuiz,
  checkAnswer,
  checkBatchAnswers,
  generateQuizFromProcedure,
  generateQuizFromChapter,
} from '../../controllers/v1/quiz.controller.ts';
import { requireAuth } from '../../config/middleware.ts';
import { requireRoles } from '../../shared/middleware/requireRoles.middleware.ts';
import { createLimiter } from '../../shared/middleware/rateLimit.middleware.ts';

const quizRoute: Router = express.Router();

// AI generation routes (super_admin & manager)
quizRoute.post(
  '/generate-from-procedure',
  requireAuth,
  requireRoles(['super_admin', 'manager']),
  createLimiter({
    limit: 15,
    message: 'Too many quiz generation requests, please try again later.',
  }),
  generateQuizFromProcedure,
);

quizRoute.post(
  '/generate-from-chapter',
  requireAuth,
  requireRoles(['super_admin', 'manager']),
  createLimiter({
    limit: 15,
    message: 'Too many quiz generation requests, please try again later.',
  }),
  generateQuizFromChapter,
);

// Public read routes (any logged-in employee)
quizRoute.get('/', requireAuth, listQuizzes);
quizRoute.get('/:id', requireAuth, getQuiz);
quizRoute.post('/:id/check-answer', requireAuth, checkAnswer);
quizRoute.post('/:id/check-answers', requireAuth, checkBatchAnswers);

// Admin routes
quizRoute.post('/', requireAuth, requireRoles(['super_admin']), createQuiz);
quizRoute.patch('/:id', requireAuth, requireRoles(['super_admin']), updateQuiz);
quizRoute.delete(
  '/:id',
  requireAuth,
  requireRoles(['super_admin']),
  deleteQuiz,
);

export default quizRoute;
