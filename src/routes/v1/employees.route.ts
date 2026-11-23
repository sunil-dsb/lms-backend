import express, { type Router } from 'express';
import * as employeesController from '../../controllers/v1/employees.controller.ts';
import { requireAuth } from '../../config/middleware.ts';
import { requireRoles } from '../../shared/middleware/requireRoles.middleware.ts';

const employeesRoute: Router = express.Router();
employeesRoute.use(requireAuth);

// ---- Specific lookup routes (must precede /:id) ---------------------------
employeesRoute.get(
  '/supervisors',
  requireRoles(['super_admin', 'manager']),
  employeesController.getSupervisors,
);

employeesRoute.get(
  '/managers',
  requireRoles(['super_admin', 'manager']),
  employeesController.getManagers,
);

employeesRoute.get(
  '/subordinates',
  requireRoles(['super_admin', 'manager', 'supervisor']),
  employeesController.getSubordinates,
);

// ---- Employees CRUD --------------------------------------------------------
employeesRoute.get(
  '/',
  requireRoles(['super_admin', 'manager', 'supervisor']),
  employeesController.listEmployees,
);

employeesRoute.get(
  '/:id',
  requireRoles(['super_admin', 'manager', 'supervisor']),
  employeesController.getEmployee,
);

employeesRoute.get(
  '/:id/training',
  requireRoles(['super_admin', 'manager', 'supervisor']),
  employeesController.getEmployeeTraining,
);

employeesRoute.post(
  '/',
  requireRoles(['super_admin', 'manager']),
  employeesController.createEmployee,
);

employeesRoute.patch(
  '/:id',
  requireRoles(['super_admin', 'manager']),
  employeesController.updateEmployee,
);

employeesRoute.post(
  '/:id/invites',
  requireRoles(['super_admin', 'manager']),
  employeesController.resendInvite,
);

employeesRoute.post(
  '/:id/deactivate',
  requireRoles(['super_admin', 'manager']),
  employeesController.deactivate,
);

export default employeesRoute;
