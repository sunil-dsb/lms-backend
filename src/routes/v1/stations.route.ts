import express, { type Router } from 'express';
import * as stationsController from '../../controllers/v1/stations.controller.ts';
import { requireAuth } from '../../config/middleware.ts';
import { requireRoles } from '../../shared/middleware/requireRoles.middleware.ts';
import { createLimiter } from '../../shared/middleware/rateLimit.middleware.ts';

const stationsRoute: Router = express.Router();

stationsRoute.get('/', requireAuth, stationsController.listStations);

stationsRoute.use(requireAuth, requireRoles(['super_admin']));

stationsRoute.post(
  '/',
  createLimiter({
    limit: 20,
    message: 'Too many stations created, please try again later.',
  }),
  stationsController.createStation,
);

stationsRoute.patch(
  '/:id',
  createLimiter({
    limit: 30,
    message: 'Too many station updates, please try again later.',
  }),
  stationsController.updateStation,
);

stationsRoute.delete(
  '/:id',
  createLimiter({
    limit: 20,
    message: 'Too many station deletions, please try again later.',
  }),
  stationsController.deleteStation,
);

export default stationsRoute;
