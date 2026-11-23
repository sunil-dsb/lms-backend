import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  uuid,
  boolean as pgBoolean,
  numeric,
} from 'drizzle-orm/pg-core';
// Note: employees.userId is `text` (not uuid) because it references user.id
// which Better Auth generates as a nanoid text string, not a UUID.
import { sql as drizzleSql, relations } from 'drizzle-orm';
export * from './auth.schema.ts';

import { user } from './auth.schema.ts';
import { locations } from './locations.schema.ts';

// ============================================================================
// Role enums — Employee operational roles vs System roles
// Manager, supervisor, and employee can be part of the Employee table
// ============================================================================
export const EMPLOYEE_ROLES = ['manager', 'supervisor', 'employee'] as const;
export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

export const SYSTEM_ROLES = ['super_admin'] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

export const ROLES = [
  'super_admin',
  'manager',
  'supervisor',
  'employee',
] as const;
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
    // Only manager, supervisor, or employee can be stored in employees table
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

    // Personal & Contact
    dateOfBirth: text('date_of_birth'),
    fathersName: text('fathers_name'),
    gender: text('gender'),
    address: text('address'),
    phoneNumber: text('phone_number'),

    // Emergency Contact
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactRelation: text('emergency_contact_relation'),
    emergencyContactPhone: text('emergency_contact_phone'),

    // Employment & Compensation
    startDate: text('start_date'),
    sinNumber: text('sin_number'),
    hourlyRate: numeric('hourly_rate', { precision: 10, scale: 2 }),

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
    byRole: index('employees_role_idx').on(t.role),
  }),
);

// ============================================================================
// Junction Tables for Hierarchy: Employee -> Supervisors, Supervisor -> Managers
// ============================================================================

export const employeeSupervisors = pgTable(
  'employee_supervisors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    supervisorId: uuid('supervisor_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniquePair: uniqueIndex('emp_sup_pair_uniq').on(
      t.employeeId,
      t.supervisorId,
    ),
    byEmployee: index('emp_sup_employee_idx').on(t.employeeId),
    bySupervisor: index('emp_sup_supervisor_idx').on(t.supervisorId),
  }),
);

export const supervisorManagers = pgTable(
  'supervisor_managers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    supervisorId: uuid('supervisor_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    managerId: uuid('manager_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniquePair: uniqueIndex('sup_mgr_pair_uniq').on(
      t.supervisorId,
      t.managerId,
    ),
    bySupervisor: index('sup_mgr_supervisor_idx').on(t.supervisorId),
    byManager: index('sup_mgr_manager_idx').on(t.managerId),
  }),
);

// ============================================================================
// Drizzle Relations
// ============================================================================

export const employeesRelations = relations(employees, ({ many }) => ({
  supervisors: many(employeeSupervisors, {
    relationName: 'employee_to_supervisors',
  }),
  subordinates: many(employeeSupervisors, {
    relationName: 'supervisor_to_employees',
  }),
  managers: many(supervisorManagers, {
    relationName: 'supervisor_to_managers',
  }),
  managedSupervisors: many(supervisorManagers, {
    relationName: 'manager_to_supervisors',
  }),
}));

export const employeeSupervisorsRelations = relations(
  employeeSupervisors,
  ({ one }) => ({
    employee: one(employees, {
      fields: [employeeSupervisors.employeeId],
      references: [employees.id],
      relationName: 'employee_to_supervisors',
    }),
    supervisor: one(employees, {
      fields: [employeeSupervisors.supervisorId],
      references: [employees.id],
      relationName: 'supervisor_to_employees',
    }),
  }),
);

export const supervisorManagersRelations = relations(
  supervisorManagers,
  ({ one }) => ({
    supervisor: one(employees, {
      fields: [supervisorManagers.supervisorId],
      references: [employees.id],
      relationName: 'supervisor_to_managers',
    }),
    manager: one(employees, {
      fields: [supervisorManagers.managerId],
      references: [employees.id],
      relationName: 'manager_to_supervisors',
    }),
  }),
);

// ============================================================================
// Inferred types
// ============================================================================

export type Employee = typeof employees.$inferSelect;
export type NewEmployee = typeof employees.$inferInsert;

export type EmployeeSupervisor = typeof employeeSupervisors.$inferSelect;
export type NewEmployeeSupervisor = typeof employeeSupervisors.$inferInsert;

export type SupervisorManager = typeof supervisorManagers.$inferSelect;
export type NewSupervisorManager = typeof supervisorManagers.$inferInsert;

// Re-export auth schema so consumers only need to import from this file
export * from './auth.schema.ts';
