import { pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core';
import { user } from './auth.schema.ts';

export const categoryStatuses = ['active', 'archived'] as const;
export type CategoryStatus = (typeof categoryStatuses)[number];

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    nameEn: text('name_en').notNull(),
    nameEs: text('name_es').notNull(),
    categoryType: text('category_type').notNull(),
    categoryIcon: text('category_icon').notNull(),
    status: text('status').$type<CategoryStatus>().notNull().default('active'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
  },
  (t) => ({
    byStatus: index('categories_status_idx').on(t.status),
  }),
);

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
