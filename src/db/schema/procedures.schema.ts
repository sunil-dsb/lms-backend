import {
  pgTable,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  uuid,
} from 'drizzle-orm/pg-core';
import { subcategories } from './subcategories.schema.ts';
import { quiz } from './quizzes.schema.ts';

import { user } from './auth.schema.ts';

export const procedureStatuses = ['draft', 'published', 'archived'] as const;
export type ProcedureStatus = (typeof procedureStatuses)[number];

export const procedures = pgTable(
  'procedures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    titleEn: text('title_en').notNull(),
    titleEs: text('title_es').notNull(),
    purposeEn: text('purpose_en').notNull(),
    purposeEs: text('purpose_es').notNull(),
    // FK to subcategories.id; SET NULL on subcategory archive keeps the procedure
    // reachable (the reader renders "â€”" instead of the subcategory pill).
    subcategoryId: uuid('subcategory_id').references(() => subcategories.id, {
      onDelete: 'set null',
    }),
    stationIds: uuid('station_ids').array(),
    quizId: uuid('quiz_id').references(() => quiz.id, {
      onDelete: 'set null',
    }),
    procedureImage: text('procedure_image'),
    assignUsers: uuid('assign_users').array(),
    status: text('status').$type<ProcedureStatus>().notNull().default('draft'),
    // Stores the status before archiving so it can be restored on unarchive.
    previousStatus: text('previous_status').$type<ProcedureStatus>(),
    blocksEn: jsonb('blocks_en').$type<unknown>().notNull(),
    blocksEs: jsonb('blocks_es').$type<unknown>().notNull(),
    createdBy: text('created_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    slugUnique: uniqueIndex('procedures_slug_uniq').on(t.slug),
    bySubcategory: index('procedures_subcategory_idx').on(t.subcategoryId),
    byQuiz: index('procedures_quiz_idx').on(t.quizId),
    byStatus: index('procedures_status_idx').on(t.status),
    // Admin lists are ordered newest-updated first.
    byUpdatedAt: index('procedures_updated_at_idx').on(t.updatedAt),
  }),
);

export type Procedure = typeof procedures.$inferSelect;
export type NewProcedure = typeof procedures.$inferInsert;
