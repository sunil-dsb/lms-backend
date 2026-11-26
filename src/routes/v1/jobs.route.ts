import express, { type Router } from 'express';
import * as jobsController from '../../controllers/v1/jobs.controller.ts';
import { requireAuth } from '../../config/middleware.ts';
import { requireRoles } from '../../shared/middleware/requireRoles.middleware.ts';
import { createLimiter } from '../../shared/middleware/rateLimit.middleware.ts';

const jobsRoute: Router = express.Router();

// Public to any authenticated employee (used by employee creation form)

// Returns stations for one or more jobs — send jobIds as a comma-separated
// query string (?jobIds=id1,id2) or as an array in the request body.
// @ts-expect-error - 'query' is a new HTTP method, Express typings may not include it yet
jobsRoute.query('/stations', requireAuth, jobsController.getJobStations);

// Read routes (super_admin, manager, and supervisor can view job roles for invites/assignments)
jobsRoute.get(
  '/',
  requireAuth,
  requireRoles(['super_admin', 'manager', 'supervisor']),
  jobsController.listJobs,
);

// Admin-only mutation routes
jobsRoute.use(requireAuth, requireRoles(['super_admin']));

jobsRoute.post(
  '/',
  createLimiter({
    limit: 20,
    message: 'Too many jobs created, please try again later.',
  }),
  jobsController.createJob,
);

jobsRoute.patch(
  '/:id',
  createLimiter({
    limit: 30,
    message: 'Too many job updates, please try again later.',
  }),
  jobsController.updateJob,
);

jobsRoute.delete(
  '/:id',
  createLimiter({
    limit: 20,
    message: 'Too many job deletions, please try again later.',
  }),
  jobsController.deleteJob,
);

export default jobsRoute;
