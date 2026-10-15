import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  uuid,
  boolean as pgBoolean,
} from 'drizzle-orm/pg-core';
// Note: employees.userId is `text` (not uuid) because it references user.id
// which Better Auth generates as a nanoid text string, not a UUID.
import { sql as drizzleSql } from 'drizzle-orm';
export * from './auth.schema.ts';

import { user } from './auth.schema.ts';
import { locations } from './locations.schema.ts';

// ============================================================================
// Role enums — Employee operational roles vs System roles
// Only manager and employee can be part of the Employee table
// ============================================================================
export const EMPLOYEE_ROLES = ['manager', 'employee'] as const;
export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

export const SYSTEM_ROLES = ['super_admin'] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

export const ROLES = ['super_admin', 'manager', 'employee'] as const;
export type Role = (typeof ROLES)[number];

// ============================================================================
// Employees, sessions
// ============================================================================

export const employeeStatus = ['pending', 'active', 'deactivated'] as const;
export type EmployeeStatus = (typeof employeeStatus)[number];

export const languagePrefs = ['en', 'es'] as const;
export type LanguagePref = (typeof languagePrefs)[number];

// 'access' = short-lived bearer sent on every API call.
// 'refresh' = long-lived token used only at /api/auth/refresh to mint a new pair.
export const sessionKinds = ['access', 'refresh'] as const;
export type SessionKind = (typeof sessionKinds)[number];

export const employees = pgTable(
  'employees',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    // LOGIN identifier. Compared case-insensitively at the route layer.
    name: text('name').notNull(),
    employeeCode: text('employee_code'),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    // Only manager or employee can be stored in employees table
    role: text('role').$type<EmployeeRole>().notNull().default('employee'),
    email: text('email').notNull(),
    jobIds: uuid('job_ids')
      .array()
      .default(drizzleSql`'{}'::uuid[]`),
    stationIds: uuid('station_ids')
      .array()
      .default(drizzleSql`'{}'::uuid[]`),
    languagePref: text('language_pref')
      .$type<LanguagePref>()
      .notNull()
      .default('en'),
    status: text('status').$type<EmployeeStatus>().notNull().default('pending'),
    requirePasswordChange: pgBoolean('require_password_change')
      .notNull()
      .default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (t) => ({
    codeUnique: uniqueIndex('employees_code_uniq')
      .on(t.employeeCode)
      .where(drizzleSql`${t.employeeCode} IS NOT NULL`),
    userIdUnique: uniqueIndex('employees_user_id_uniq').on(t.userId),
    // Emails are stored lowercased (see the validation schema). The service
    // checks for clashes first; this index guards against concurrent requests.
    emailUnique: uniqueIndex('employees_email_uniq').on(t.email),
    // Used by location delete checks and the ON DELETE restrict FK check.
    byLocation: index('employees_location_idx').on(t.locationId),
  }),
);

// ============================================================================
// Inferred types
// ============================================================================

export type Employee = typeof employees.$inferSelect;
export type NewEmployee = typeof employees.$inferInsert;

// Re-export auth schema so consumers only need to import from this file
export * from './auth.schema.ts';
