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

/**
 * Validates international / North American phone numbers:
 * - 10 to 15 digits
 * - Allows optional leading + and separators: spaces, hyphens, parentheses, dots
 * - Rejects non-phone symbols and repeating dummy digits (e.g. 0000000000)
 */
export const isValidPhoneNumber = (val: string): boolean => {
  if (!val || typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (!/^\+?[0-9\s\-().]{10,25}$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  return true;
};

/**
 * Validates calendar date string in YYYY-MM-DD format (checks real calendar days, e.g. Feb 31 invalid)
 */
export const isValidDate = (dateStr: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const parts = dateStr.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!year || !month || !day) return false;
  const d = new Date(year, month - 1, day);
  return (
    d.getFullYear() === year &&
    d.getMonth() === month - 1 &&
    d.getDate() === day
  );
};

/**
 * Validates date of birth: must be valid date, in the past, age between 14 and 100
 */
export const isValidDateOfBirth = (
  dateStr: string,
): { valid: boolean; message?: string } => {
  if (!isValidDate(dateStr)) {
    return {
      valid: false,
      message: 'Date of birth must be a valid date in YYYY-MM-DD format',
    };
  }
  const parts = dateStr.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!year || !month || !day) {
    return { valid: false, message: 'Invalid date values' };
  }
  const dob = new Date(year, month - 1, day);
  const today = new Date();

  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
    age--;
  }

  if (dob > today) {
    return { valid: false, message: 'Date of birth cannot be in the future' };
  }
  if (age < 14) {
    return {
      valid: false,
      message: 'Employee must be at least 14 years of age',
    };
  }
  if (age > 100) {
    return { valid: false, message: 'Please enter a valid date of birth' };
  }
  return { valid: true };
};

export const baseEmployeeSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(120, 'Name must not exceed 120 characters'),
  email: z.string().email('Please enter a valid email address').toLowerCase(),
  locationId: z
    .string()
    .min(1, 'Location ID is required')
    .uuid('Location ID must be a valid UUID'),
  role: roleEnum.default('employee'),
  jobIds: z
    .array(z.string().uuid('Job ID must be a valid UUID'))
    .optional()
    .default([]),
  stationIds: z
    .array(z.string().uuid('Station ID must be a valid UUID'))
    .optional()
    .default([]),
  employeeCode: z
    .string()
    .trim()
    .refine((val) => val.length === 0 || val.length === 6, {
      message: 'Employee code must be exactly 6 characters',
    })
    .transform((val) => (val === '' ? null : val))
    .nullable()
    .optional(),
  languagePref: z.enum(['en', 'es']).default('en'),
  status: statusEnum.exclude(['all']).optional().default('pending'),

  // Personal & Contact Details (REQUIRED)
  dateOfBirth: z
    .string()
    .trim()
    .min(1, 'Date of birth is required')
    .refine(
      (val) => isValidDateOfBirth(val).valid,
      'Date of birth must be a valid date in YYYY-MM-DD format (minimum age 14)',
    ),
  fathersName: z
    .string()
    .trim()
    .min(1, "Father's name is required")
    .max(100, "Father's name cannot exceed 100 characters"),
  gender: genderEnum,
  address: z
    .string()
    .trim()
    .min(1, 'Address is required')
    .max(500, 'Address cannot exceed 500 characters'),
  phoneNumber: z
    .string()
    .trim()
    .min(1, 'Phone number is required')
    .refine(
      isValidPhoneNumber,
      'Please enter a valid phone number (10 to 15 digits, e.g. 416-555-0199 or +1 416 555 0199)',
    ),

  // Emergency Contact Details (REQUIRED)
  emergencyContactName: z
    .string()
    .trim()
    .min(1, 'Emergency contact name is required')
    .max(100, 'Emergency contact name cannot exceed 100 characters'),
  emergencyContactRelation: z
    .string()
    .trim()
    .min(1, 'Emergency contact relation is required')
    .max(50, 'Emergency contact relation cannot exceed 50 characters'),
  emergencyContactPhone: z
    .string()
    .trim()
    .min(1, 'Emergency contact phone is required')
    .refine(
      isValidPhoneNumber,
      'Please enter a valid emergency phone number (10 to 15 digits, e.g. 416-555-0199)',
    ),

  // Employment & Compensation (REQUIRED)
  startDate: z
    .string()
    .trim()
    .min(1, 'Start date is required')
    .refine(
      isValidDate,
      'Start date must be a valid date in YYYY-MM-DD format',
    ),
  sinNumber: z
    .string()
    .trim()
    .min(1, 'SIN number is required')
    .regex(
      /^(\d{3}-?\d{3}-?\d{3}|\d{9})$/,
      'SIN must be a 9-digit number (e.g. 123-456-789 or 123456789)',
    ),
  hourlyRate: z.union([
    z
      .string()
      .trim()
      .min(1, 'Hourly rate is required')
      .regex(
        /^\d{1,4}(\.\d{1,2})?$/,
        'Hourly rate must be a valid amount between $0.01 and $9999.99 (e.g. 21.50)',
      )
      .refine((val) => Number(val) > 0, 'Hourly rate must be greater than 0'),
    z
      .number()
      .positive('Hourly rate must be greater than 0')
      .max(9999.99, 'Hourly rate cannot exceed $9,999.99'),
  ]),

  // Reporting Hierarchy
  supervisorIds: z
    .array(z.string().uuid('Invalid supervisor ID format'))
    .optional()
    .default([]),
  managerIds: z
    .array(z.string().uuid('Invalid manager ID format'))
    .optional()
    .default([]),
  subordinateIds: z
    .array(z.string().uuid('Invalid subordinate ID format'))
    .optional()
    .default([]),
});

export const createSchema = baseEmployeeSchema.superRefine((data, ctx) => {
  if (data.role === 'employee') {
    if (!data.jobIds || data.jobIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['jobIds'],
        message: 'At least one job role is required for employees',
      });
    }
    if (!data.stationIds || data.stationIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stationIds'],
        message: 'At least one kitchen station is required for employees',
      });
    }
    if (!data.supervisorIds || data.supervisorIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supervisorIds'],
        message: 'At least one reporting supervisor is required for employees',
      });
    }
  }
  if (
    data.role === 'supervisor' &&
    (!data.managerIds || data.managerIds.length === 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['managerIds'],
      message: 'At least one reporting manager is required for supervisors',
    });
  }
});

// Employee edits now share the invite form's complete field set, including
// employeeCode and the reporting hierarchy requirements.
export const updateSchema = createSchema;
export const patchSchema = baseEmployeeSchema.partial();

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
