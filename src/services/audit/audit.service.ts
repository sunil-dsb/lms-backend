import {
  and,
  desc,
  eq,
  gte,
  lte,
  count,
  ilike,
  or,
  type SQL,
} from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  auditLogs,
  type AuditAction,
  type AuditChanges,
  type AuditItemType,
} from '../../db/index.ts';
import {
  formatPaginatedResult,
  type PaginatedResult,
} from '../../shared/utils/pagination.ts';
import { logger } from '../../config/logger.ts';

// ---------------------------------------------------------------------------
// Audit log service
//
// recordAudit() writes one row describing a mutation that already happened.
// It is deliberately fire-and-forget: a failure to write the audit row must
// never surface as a failed course/procedure/settings change. Everything it
// does is wrapped in try/catch and logged instead of thrown.
//
// listAuditLogs() backs GET /api/v1/audit-logs for the admin page.
// ---------------------------------------------------------------------------

/**
 * Either the pooled client or an open transaction. Passing `tx` keeps the
 * audit row atomic with the change it describes: a rollback discards both,
 * and no second pooled connection is taken mid-transaction.
 */
type DbExecutor =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Who performed the action. Pulled straight off the request by controllers. */
export interface AuditActor {
  /** `req.userId` — user.id (text/nanoid). */
  userId?: string | undefined;
  /** `req.user?.name` — snapshot so the entry survives user deletion. */
  name?: string | undefined;
}

export interface RecordAuditInput {
  actor: AuditActor;
  itemType: AuditItemType;
  /** Id of the record that changed. */
  itemId: string;
  /** Title/name snapshot — keeps the entry readable after a hard delete. */
  itemName?: string | null;
  action: AuditAction;
  /** Field-level before/after values. Omit when only "did it happen" matters. */
  changes?: AuditChanges | null;
  /** Pass the surrounding `tx` when recording inside a transaction. */
  executor?: DbExecutor;
}

/**
 * Writes an audit row. Never throws.
 *
 * Call this AFTER the mutation's own writes. Inside a transaction, pass
 * `executor: tx` so the row commits and rolls back with them.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    const executor = input.executor ?? db;
    await executor.insert(auditLogs).values({
      userId: input.actor.userId ?? null,
      // Fall back to a placeholder rather than violating the NOT NULL: an
      // audit row with no actor is still better than no audit row at all.
      userName: input.actor.name?.trim() || 'Unknown user',
      itemType: input.itemType,
      itemId: input.itemId,
      itemName: input.itemName ?? null,
      action: input.action,
      changes: input.changes ?? null,
    });
  } catch (err) {
    logger.error(
      {
        err,
        itemType: input.itemType,
        itemId: input.itemId,
        action: input.action,
      },
      'Failed to write audit log row',
    );
  }
}

/**
 * Computes a field-level diff between a record before and after a change.
 * Only fields present in `keys` are compared, and unchanged fields are
 * omitted — so the stored `changes` object stays small and the UI only shows
 * what actually moved.
 */
export function diffChanges<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: readonly (keyof T & string)[],
): AuditChanges | null {
  const changes: AuditChanges = {};

  for (const key of keys) {
    const from = before[key];
    const to = after[key];
    if (isSameValue(from, to)) continue;
    changes[key] = { from: from ?? null, to: to ?? null };
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

export function isSameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  // Dates, arrays and objects (blocks jsonb) need a structural compare.
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * One short label per rich-content block, for storing a readable before/after
 * snapshot of chapter/procedure content in `changes`. The raw block JSON is
 * the whole document body — far too big for an audit row — so we keep only
 * what identifies each block: the heading/text/title, or the block kind as a
 * fallback. EN first: audit snapshots are EN, same as itemName.
 */
export function summarizeBlocks(blocks: unknown[]): string[] {
  return blocks.map(blockLabel);
}

const BLOCK_LABEL_MAX = 60;

function blockLabel(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const b = raw as Record<string, unknown>;
  const kind = typeof b.kind === 'string' ? b.kind : 'block';

  const text =
    firstText(b.text) ??
    firstText(b.body) ??
    flattenRichText(b.body) ??
    firstText(b.title) ??
    firstText(b.alt) ??
    firstText(b.caption);

  return text ? clip(text, BLOCK_LABEL_MAX) : kind;
}

/** A `Localised` field: `{ en, es }` (or a plain string). */
function firstText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') {
    const s = (v as Record<string, unknown>).en;
    if (typeof s === 'string') return s.trim() || null;
  }
  return null;
}

/** rich_text bodies are Tiptap docs — pull the first words out of them. */
function flattenRichText(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const doc = (v as Record<string, unknown>).en;
  if (!doc || typeof doc !== 'object') return null;

  const words: string[] = [];
  let budget = BLOCK_LABEL_MAX;
  const walk = (node: unknown): void => {
    if (budget <= 0 || !node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (typeof n.text === 'string' && n.text.trim()) {
      words.push(n.text.trim());
      budget -= n.text.length;
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
    }
  };
  walk(doc);

  const s = words.join(' ').trim();
  return s || null;
}

function clip(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * One short label per quiz question: the prompt with its choices listed and
 * the correct one marked ✓. Question JSON (prompts, choices, answer ids) is
 * too big for an audit row, and a count alone would miss the common edit —
 * fixing a choice or moving the correct answer — so every part a reviewer
 * could change appears in the label.
 */
export function summarizeQuestions(questions: unknown): string[] {
  if (!Array.isArray(questions)) return [];
  return questions.map(questionLabel);
}

const QUESTION_LABEL_MAX = 48;
const CHOICE_LABEL_MAX = 16;

function questionLabel(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const q = raw as Record<string, unknown>;

  const prompt = firstText(q.question) ?? 'Question';
  const head = clip(prompt, QUESTION_LABEL_MAX);

  const choices = Array.isArray(q.choices) ? q.choices : [];
  const parts: string[] = [];
  for (const c of choices) {
    if (!c || typeof c !== 'object') continue;
    const choice = c as Record<string, unknown>;
    const label = firstText(choice.label) ?? '';
    const correct = choice.id === q.correctChoiceId;
    if (!label && !correct) continue;
    parts.push(clip(correct ? `${label} ✓`.trim() : label, CHOICE_LABEL_MAX));
  }

  return parts.length > 0 ? `${head} [${parts.join(', ')}]` : head;
}

/**
 * Chapter-content snapshot used when a whole chapter appears or disappears:
 * its block labels, or the chapter title when it has no content yet — so the
 * entry always says *what* went away, never just "—".
 */
export function chapterContentSnapshot(
  titleEn: string,
  blocks: unknown[],
): string[] {
  const labels = summarizeBlocks(blocks);
  return labels.length > 0 ? labels : [titleEn];
}

export interface ListAuditLogsParams {
  /** Filter to one kind of record. */
  itemType?: AuditItemType | undefined;
  /** Filter to one action. */
  action?: AuditAction | undefined;
  /** Filter to one actor's user id. */
  userId?: string | undefined;
  /** Inclusive lower bound on created_at (YYYY-MM-DD). */
  from?: string | undefined;
  /** Inclusive upper bound on created_at (YYYY-MM-DD). */
  to?: string | undefined;
  /** Free-text over item name and actor name. */
  search?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

/** Paginated audit list, newest first. */
export async function listAuditLogs(
  params: ListAuditLogsParams,
): Promise<PaginatedResult<typeof auditLogs.$inferSelect>> {
  const {
    itemType,
    action,
    userId,
    from,
    to,
    search,
    page = 1,
    limit = 20,
  } = params;
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [];

  if (itemType) conditions.push(eq(auditLogs.itemType, itemType));
  if (action) conditions.push(eq(auditLogs.action, action));
  if (userId) conditions.push(eq(auditLogs.userId, userId));

  // Date bounds can be passed as YYYY-MM-DD or full ISO strings.
  // When 'to' is a bare date, expand it to end-of-day so records from that day are included.
  if (from) {
    conditions.push(gte(auditLogs.createdAt, new Date(from)));
  }
  if (to) {
    const toDate = new Date(to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(to.trim())) {
      toDate.setUTCHours(23, 59, 59, 999);
    }
    conditions.push(lte(auditLogs.createdAt, toDate));
  }

  if (search && search.trim().length > 0) {
    const term = `%${search.trim()}%`;
    conditions.push(
      or(
        ilike(auditLogs.itemName, term),
        ilike(auditLogs.userName, term),
        ilike(auditLogs.action, term),
      )!,
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult] = await db
    .select({ total: count() })
    .from(auditLogs)
    .where(whereClause);
  const total = countResult?.total ?? 0;

  const rows = await db
    .select()
    .from(auditLogs)
    .where(whereClause)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return formatPaginatedResult(rows, Number(total), page, limit);
}
