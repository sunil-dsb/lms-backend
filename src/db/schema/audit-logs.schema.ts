import {
  pgTable,
  text,
  timestamp,
  index,
  uuid,
  jsonb,
} from 'drizzle-orm/pg-core';
import { user } from './auth.schema.ts';

// ---------------------------------------------------------------------------
// Audit log — who changed a course, procedure, assignment or setting, when,
// and the before/after values of the fields that changed.
//
// One row per mutation.
//
// user_name is a snapshot taken at write time: user_id is SET NULL when the
// user row is deleted, but the entry must still say who did it. item_name
// works the same way so a deleted course or procedure still reads sensibly.
//
// Writing an audit row must never break the mutation it describes — the
// service that inserts these swallows its own errors.
// ---------------------------------------------------------------------------

/** What kind of record changed. */
export const auditItemTypes = [
  'course',
  'chapter',
  'procedure',
  'assignment',
  'station',
  'location',
  'job',
] as const;
export type AuditItemType = (typeof auditItemTypes)[number];

/** What was done to it. */
export const auditActions = [
  'create',
  'update',
  'delete',
  'publish',
  'archive',
  'unarchive',
  'assign',
  'unassign',
  'reorder',
  'override',
  'revoke_override',
] as const;
export type AuditAction = (typeof auditActions)[number];

/** Field-level diff: `{ "dueDate": { "from": "2026-11-18", "to": "2026-11-25" } }`. */
export type AuditChanges = Record<string, { from: unknown; to: unknown }>;

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Who did it — `user.id` (text/nanoid), SET NULL when the user is deleted. */
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    /** Who did it, as named at the time. Survives user deletion. */
    userName: text('user_name').notNull(),

    /** Which kind of record changed: 'course' | 'procedure' | 'station' | ... */
    itemType: text('item_type').$type<AuditItemType>().notNull(),
    /** Id of the record that changed. Text so it covers uuid and non-uuid ids. */
    itemId: text('item_id').notNull(),
    /** Title/name snapshot so the entry stays readable after a hard delete. */
    itemName: text('item_name'),

    /** 'create' | 'update' | 'delete' | 'publish' | 'archive' | ... */
    action: text('action').$type<AuditAction>().notNull(),

    /** Before/after values for the fields that changed. Null when not tracked. */
    changes: jsonb('changes').$type<AuditChanges | null>(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // "history of this one course / procedure"
    byItem: index('audit_logs_item_idx').on(t.itemType, t.itemId),
    // "what did this person do"
    byUser: index('audit_logs_user_idx').on(t.userId),
    // list ordering + date-range filters
    byDate: index('audit_logs_date_idx').on(t.createdAt),
  }),
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
