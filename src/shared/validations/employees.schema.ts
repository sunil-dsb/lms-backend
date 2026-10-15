import { z } from 'zod';
import { EMPLOYEE_ROLES } from '../../db/employee.schema.ts';

export const roleEnum = z.enum(EMPLOYEE_ROLES);
export const statusEnum = z.enum(['pending', 'active', 'deactivated', 'all']);

export const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().email().toLowerCase(),
  locationId: z.string().min(1).max(64),
  role: roleEnum.default('employee'),
  jobIds: z.array(z.string().min(1).max(64)).optional().default([]),
  stationIds: z.array(z.string().min(1).max(64)).optional().default([]),
  employeeCode: z
    .string()
    .trim()
    .length(6, 'Employee code must be exactly 6 characters')
    .nullable()
    .optional(),
  languagePref: z.enum(['en', 'es']).optional().default('en'),
  status: statusEnum.exclude(['all']).optional().default('pending'),
});

export const updateSchema = createSchema.omit({ employeeCode: true });
export const patchSchema = createSchema.partial();

export const idParam = z.object({ id: z.string().uuid() });

// Slug ids for stations / roles / locations — lowercase, digits, dashes, 1-64 chars.
// Matches the seeded values (e.g. \`loc-main\`, \`role-general\`, \`stn-hot-line\`).
export const slugIdParam = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
});

export const stationCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
export const stationPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});

export const locationCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
export const locationPatchSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const jobCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  stationIds: z.array(z.string().uuid()).optional().default([]),
});
export const jobPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  stationIds: z.array(z.string().uuid()).optional(),
});
