import 'express';
import type { Logger } from 'pino';
import type { Role } from '../db/schema/employees.schema.ts';

/**
 * Shape of the employee row that middleware attaches to `req.employee`
 * after a successful clearance check.
 */
export interface AuthedEmployee {
  id: string;
  userId?: string | undefined;
  name: string;
  locationId: string;
  role: Role;
  email: string | null;
  languagePref: 'en' | 'es';
  status: 'pending' | 'active' | 'deactivated';
}

declare global {
  namespace Express {
    interface Request {
      id?: string;
      userId?: string;
      log?: Logger;
      isSuperAdmin?: boolean;
      /**
       * Populated by `requireAuth` with `{ id, locationId, role }` so any
       * controller behind any auth-only mount can read basic identity.
       */
      employee?: Partial<AuthedEmployee> & {
        id: string;
        userId?: string | undefined;
        locationId: string;
        role: Role | 'super_admin';
        stationIds?: string[] | null;
      };
    }
  }
}

export {};
