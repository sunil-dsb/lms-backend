import { z } from 'zod';
import { EMPLOYEE_ROLES } from '../../db/employee.schema.ts';

export const roleEnum = z.enum(EMPLOYEE_ROLES);
export const statusEnum = z.enum(['pending', 'active', 'deactivated', 'all']);
export const genderEnum = z.enum([
  'male',
  'female',
  'other',
  'prefer_not_to_say',
]);

export const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(120, 'Name must not exceed 120 characters'),
  email: z.string().email('Please enter a valid email address').toLowerCase(),
  locationId: z.string().min(1, 'Location is required').max(64),
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

  // Personal & Contact Details
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be in YYYY-MM-DD format')
    .nullable()
    .optional(),
  fathersName: z
    .string()
    .trim()
    .max(100, "Father's name cannot exceed 100 characters")
    .nullable()
    .optional(),
  gender: genderEnum.nullable().optional(),
  address: z
    .string()
    .trim()
    .max(500, 'Address cannot exceed 500 characters')
    .nullable()
    .optional(),
  phoneNumber: z
    .string()
    .trim()
    .max(30, 'Phone number cannot exceed 30 characters')
    .nullable()
    .optional(),

  // Emergency Contact Details
  emergencyContactName: z
    .string()
    .trim()
    .max(100, 'Emergency contact name cannot exceed 100 characters')
    .nullable()
    .optional(),
  emergencyContactRelation: z
    .string()
    .trim()
    .max(50, 'Emergency contact relation cannot exceed 50 characters')
    .nullable()
    .optional(),
  emergencyContactPhone: z
    .string()
    .trim()
    .max(30, 'Emergency contact phone cannot exceed 30 characters')
    .nullable()
    .optional(),

  // Employment & Compensation
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Start date must be in YYYY-MM-DD format')
    .nullable()
    .optional(),
  sinNumber: z
    .string()
    .trim()
    .regex(
      /^(\d{3}-?\d{3}-?\d{3}|\d{9})$/,
      'SIN must be a 9-digit number (e.g. 123-456-789 or 123456789)',
    )
    .nullable()
    .optional(),
  hourlyRate: z
    .union([
      z
        .string()
        .regex(
          /^\d+(\.\d{1,2})?$/,
          'Hourly rate must be a valid amount (e.g. 21.50)',
        ),
      z.number().positive('Hourly rate must be a positive number'),
    ])
    .nullable()
    .optional(),

  // Reporting Hierarchy
  supervisorIds: z
    .array(z.string().uuid('Invalid supervisor ID format'))
    .optional()
    .default([]),
  managerIds: z
    .array(z.string().uuid('Invalid manager ID format'))
    .optional()
    .default([]),
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
