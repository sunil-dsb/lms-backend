import express, { type Router } from 'express';
import * as locationsController from '../../controllers/v1/locations.controller.ts';
import { requireAuth } from '../../config/middleware.ts';
import { requireRoles } from '../../shared/middleware/requireRoles.middleware.ts';
import { createLimiter } from '../../shared/middleware/rateLimit.middleware.ts';

const locationsRoute: Router = express.Router();

locationsRoute.get('/', requireAuth, locationsController.listLocations);

locationsRoute.use(requireAuth, requireRoles(['super_admin']));

locationsRoute.post(
  '/',
  createLimiter({
    limit: 20,
    message: 'Too many locations created, please try again later.',
  }),
  locationsController.createLocation,
);

locationsRoute.patch(
  '/:id',
  createLimiter({
    limit: 30,
    message: 'Too many location updates, please try again later.',
  }),
  locationsController.updateLocation,
);

locationsRoute.delete(
  '/:id',
  createLimiter({
    limit: 20,
    message: 'Too many location deletions, please try again later.',
  }),
  locationsController.deleteLocation,
);

export default locationsRoute;
