import express, { type Router } from 'express';
import { listAuditLogs } from '../../controllers/v1/audit.controller.ts';
import { requireAuth } from '../../config/middleware.ts';
import { requireRoles } from '../../shared/middleware/requireRoles.middleware.ts';
import { createLimiter } from '../../shared/middleware/rateLimit.middleware.ts';

const auditRoute: Router = express.Router();

// Read-only, admin-only: the whole log across every entity.
auditRoute.get(
  '/',
  requireAuth,
  requireRoles(['super_admin']),
  createLimiter({
    limit: 60,
    message: 'Too many audit log requests, please try again later.',
  }),
  listAuditLogs,
);

export default auditRoute;
