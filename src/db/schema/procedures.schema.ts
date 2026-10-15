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
import { quiz } from './quiz.schema.ts';

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

import { z } from 'zod';

// ===========================================================================
// Zod body schemas
// ===========================================================================
// Validate the JSON block bodies stored in blocksEn / blocksEs, and the
// create-procedure API input. Kept here alongside the Drizzle table so all
// procedure-domain types live in one place.

// ===========================================================================
// Procedure Body Schema
// ===========================================================================
// Zod schemas that define the structure of a fully-authored procedure body.
// Every free-form string field must be bilingual (en + es). These are the
// strict schemas used when saving/reading procedures from the database.

// A text field filled in for both languages. Every free-form string
// in a block uses this so the procedure has real bilingual content —
// no fallback, no `English only`.
export const localisedString = z.object({
  en: z.string().min(1),
  es: z.string().min(1),
});

// Same shape, but each side is optional. Used for captions, alt text, and
// other supporting copy where one side may legitimately be empty.
export const localisedStringOptional = z.object({
  en: z.string().optional(),
  es: z.string().optional(),
});

// Shared critical limit sub-shape. Lives inside method and recipe blocks.
export const criticalLimitSchema = z.object({
  label: z.string().min(1).optional(),
  icon: z.string().min(1).optional(),
  value: z.string().min(1),
  subtitle: z.string().optional(),
  howToCheck: z.string().min(1),
  breachLabel: z.string().min(1),
  breachResponse: z.string().min(1),
});

// Per-step video clip. startSec/endSec are integers (seconds).
export const videoSegmentSchema = z
  .object({
    src: z.string().min(1),
    startSec: z.number().int().min(0),
    endSec: z.number().int().min(0),
  })
  .refine((v) => v.endSec > v.startSec, {
    message: 'endSec must be greater than startSec',
    path: ['endSec'],
  });

// Backfill shim — wrap legacy string body in { en: <body>, es: '' } so old
// procedures load unchanged. New procedures must fill both sides.
const stepBodySchema = z.preprocess(
  (v) => (typeof v === 'string' ? { en: v, es: '' } : v),
  localisedString,
);

// A single step inside a method or recipe block.
const methodStepSchema = z.object({
  id: z.string().min(1),
  phase: localisedStringOptional.optional(),
  body: stepBodySchema,
  critical: z.boolean().optional(),
  criticalLimit: criticalLimitSchema.optional(),
  videoSegment: videoSegmentSchema.optional(),
  timer: z.object({ seconds: z.number(), label: z.string() }).optional(),
  images: z
    .array(
      z.object({
        src: z.string(),
        alt: localisedStringOptional,
        caption: localisedStringOptional.optional(),
      }),
    )
    .optional(),
  discardAt: z.boolean().optional(),
  discardAtHours: z.number().optional(),
  compareImages: z.boolean().optional(),
  note: z.object({ severity: z.string(), body: localisedString }).optional(),
  videoSrc: z.string().optional(),
  videoCaption: z.string().optional(),
});
export type MethodStepInput = z.infer<typeof methodStepSchema>;

// Recipe sub-shapes.
export const allergenSchema = z.object({
  summary: z.string().min(1),
  detail: z.string().min(1),
  selectedAllergens: z.array(z.string().min(1)).optional(),
});

export const yieldItemSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  unit: z.string().optional(),
  scales: z.boolean().optional(),
});

export const ingredientSchema = z.object({
  name: z.string().min(1),
  form: z.string().optional(),
  allergen: z.boolean().optional(),
  unit: z.string().optional(), // The editor keeps one slot per configured batch factor. When a recipe only
  // has a base amount, higher-scale slots are intentionally empty strings.
  amounts: z.array(z.string()).default([]),
});
// ---------------------------------------------------------------------------
// Block discriminated union
// ---------------------------------------------------------------------------

const textBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('text'),
  body: localisedString,
});

const headingBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('heading'),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  text: localisedString,
});

const methodBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('method'),
  steps: z
    .array(methodStepSchema)
    .min(1, 'A method block needs at least one step.'),
});

const imageBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('image'),
  src: z.string().min(1),
  alt: localisedString,
  caption: localisedStringOptional.optional(),
  hint: z.enum(['photo', 'diagram']).default('photo'),
});

const videoBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('video'),
  src: z.string().url(),
  caption: localisedStringOptional,
});

const warningBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('warning'),
  severity: z.enum(['warn', 'tip', 'alt', 'equip', 'allergen']),
  body: localisedString,
});

const attachmentBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('attachment'),
  title: localisedString,
  href: z.string().min(1),
  meta: z.string().optional(),
});

const tableCellString = z.object({
  en: z.string(),
  es: z.string(),
});

const tableBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('table'),
  headers: z.array(tableCellString).min(1),
  rows: z.array(z.array(tableCellString)),
});

const ingredientsBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('ingredients'),
  audience: z.string().optional(),
  allergen: allergenSchema.optional(),
  yieldItems: z.array(yieldItemSchema).optional(),
  factors: z.array(z.number().int().positive()).optional(),
  ingredients: z.array(ingredientSchema).optional(),
});

const checklistBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('checklist'),
  title: localisedString,
  items: z.array(
    z.object({
      id: z.string(),
      text: localisedString,
    }),
  ),
});

export const blockSchema = z.discriminatedUnion('kind', [
  textBlockSchema,
  headingBlockSchema,
  methodBlockSchema,
  imageBlockSchema,
  videoBlockSchema,
  warningBlockSchema,
  attachmentBlockSchema,
  tableBlockSchema,
  ingredientsBlockSchema,
  checklistBlockSchema,
]);
export type Block = z.infer<typeof blockSchema>;
export type BlockKind = Block['kind'];

// ---------------------------------------------------------------------------
// ProcedureBody + create input
// ---------------------------------------------------------------------------

export const procedureBodySchema = z.object({
  blocks: z.array(blockSchema).min(1, 'At least one block is required.'),
});
export type ProcedureBody = z.infer<typeof procedureBodySchema>;

export const createProcedureInputSchema = z.object({
  titleEn: z.string().min(1).max(200),
  titleEs: z.string().min(1).max(200),
  purposeEn: z.string().min(1),
  purposeEs: z.string().min(1),
  // UUID of the joined subcategory from the subcategories table. Nullable —
  // the procedure is allowed to live without a subcategory (e.g. right after
  // a subcategory is archived and before the manager re-assigns it).
  subcategoryId: z.string().uuid().nullable().optional(),
  stationIds: z.array(z.string().uuid()).nullable().optional(),
  quizId: z.string().uuid().nullable().optional(),
  procedureImage: z.string().url().nullable().optional(),
  assignUsers: z.array(z.string().uuid()).optional(),
  status: z.enum(['draft', 'published']).default('draft'),
  bodyEn: procedureBodySchema,
  bodyEs: procedureBodySchema,
});
export type CreateProcedureInput = z.infer<typeof createProcedureInputSchema>;

export const updateProcedureInputSchema = createProcedureInputSchema.partial();
export type UpdateProcedureInput = z.infer<typeof updateProcedureInputSchema>;
