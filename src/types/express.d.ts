import 'express';
import type { Logger } from 'pino';
import type { EmployeeRole } from '../db/schema/employees.schema.ts';

export interface AuthedUser {
  id: string;
  name: string;
  email: string;
  role: 'super_admin' | 'user';
}

export interface AuthedEmployee {
  id: string; // employee UUID
  userId: string;
  name: string;
  locationId: string;
  role: EmployeeRole; // 'manager' | 'employee'
  email: string | null;
  languagePref: 'en' | 'es';
  status: 'pending' | 'active' | 'deactivated';
  stationIds?: string[] | null;
  jobIds?: string[] | null;
}

declare global {
  namespace Express {
    interface Request {
      id?: string | undefined;
      userId?: string | undefined; // Always populated when authenticated
      user?: AuthedUser | undefined; // Platform user from `user` table
      isSuperAdmin?: boolean | undefined; // Convenience flag: user.role === 'super_admin'
      employee?: AuthedEmployee | undefined; // Only present if user is a manager or employee!
      log?: Logger | undefined;
    }
  }
}

export {};
