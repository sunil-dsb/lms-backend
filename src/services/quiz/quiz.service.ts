import ApiError from '../../shared/utils/ApiError.ts';
import crypto from 'node:crypto';
import { desc, eq, count, ilike, or } from 'drizzle-orm';
import {
  formatPaginatedResult,
  type PaginatedResult,
} from '../../shared/utils/pagination.ts';
import { db } from '../../db/client.ts';
import { quiz, procedures } from '../../db/index.ts';
import {
  type CreateQuizInput,
  createQuizInputSchema,
  type UpdateQuizInput,
  updateQuizInputSchema,
  type Quiz,
  type QuizWithProcedure,
  type QuizProcedureSummary,
} from '../../db/quiz.schema.ts';

async function getProcedureForQuiz(
  quizId: string,
): Promise<QuizProcedureSummary | null> {
  const [proc] = await db
    .select({
      id: procedures.id,
      slug: procedures.slug,
      titleEn: procedures.titleEn,
      titleEs: procedures.titleEs,
      status: procedures.status,
    })
    .from(procedures)
    .where(eq(procedures.quizId, quizId))
    .limit(1);

  return proc ?? null;
}

export async function createQuiz(
  input: CreateQuizInput,
  actor: { userId?: string | undefined },
): Promise<QuizWithProcedure> {
  // Validate questions schema properly
  const parsed = createQuizInputSchema.parse(input);

  const id = crypto.randomUUID();

  await db.insert(quiz).values({
    id,
    nameEn: parsed.nameEn,
    nameEs: parsed.nameEs,
    quizType: parsed.quizType || 'procedure',
    questions: parsed.questions,
    createdBy: actor.userId || null,
  });

  if (parsed.procedureId) {
    await db
      .update(procedures)
      .set({ quizId: id })
      .where(eq(procedures.id, parsed.procedureId));
  }

  const [created] = await db
    .select()
    .from(quiz)
    .where(eq(quiz.id, id))
    .limit(1);

  if (!created) {
    throw Object.assign(new ApiError('Inserted quiz not found', 500), {
      errorCode: 'INTERNAL_ERROR',
    });
  }

  const proc = await getProcedureForQuiz(id);

  return {
    ...created,
    procedureId: proc?.id ?? null,
    procedure: proc,
  };
}

export async function getQuiz(id: string): Promise<QuizWithProcedure> {
  const [row] = await db.select().from(quiz).where(eq(quiz.id, id)).limit(1);

  if (!row) {
    throw Object.assign(new ApiError('Quiz not found', 404), {
      errorCode: 'QUIZ_NOT_FOUND',
    });
  }

  const proc = await getProcedureForQuiz(id);

  return {
    ...row,
    procedureId: proc?.id ?? null,
    procedure: proc,
  };
}

export async function listQuizzes(
  page: number = 1,
  limit: number = 10,
  search?: string,
): Promise<PaginatedResult<QuizWithProcedure>> {
  const offset = (page - 1) * limit;
  const whereClause = search
    ? or(ilike(quiz.nameEn, `%${search}%`), ilike(quiz.nameEs, `%${search}%`))!
    : undefined;
  const rows = await db
    .select({
      quiz,
      procedure: {
        id: procedures.id,
        slug: procedures.slug,
        titleEn: procedures.titleEn,
        titleEs: procedures.titleEs,
        status: procedures.status,
      },
    })
    .from(quiz)
    .leftJoin(procedures, eq(procedures.quizId, quiz.id))
    .where(whereClause)
    .orderBy(desc(quiz.createdAt))
    .limit(limit)
    .offset(offset);

  const [countRes] = await db
    .select({ total: count() })
    .from(quiz)
    .where(whereClause);

  const items: QuizWithProcedure[] = rows.map((r) => ({
    ...(r.quiz as Quiz),
    procedureId: r.procedure?.id ?? null,
    procedure: r.procedure?.id ? r.procedure : null,
  }));

  return formatPaginatedResult(items, countRes?.total ?? 0, page, limit);
}

export async function updateQuiz(
  id: string,
  input: UpdateQuizInput,
): Promise<QuizWithProcedure> {
  const parsed = updateQuizInputSchema.parse(input);

  const [existing] = await db
    .select()
    .from(quiz)
    .where(eq(quiz.id, id))
    .limit(1);

  if (!existing) {
    throw Object.assign(new ApiError('Quiz not found', 404), {
      errorCode: 'QUIZ_NOT_FOUND',
    });
  }

  const updateData: Partial<typeof quiz.$inferInsert> = {};
  if (parsed.nameEn !== undefined) updateData.nameEn = parsed.nameEn;
  if (parsed.nameEs !== undefined) updateData.nameEs = parsed.nameEs;
  if (parsed.quizType !== undefined) updateData.quizType = parsed.quizType;
  if (parsed.questions !== undefined) updateData.questions = parsed.questions;

  if (Object.keys(updateData).length > 0) {
    await db.update(quiz).set(updateData).where(eq(quiz.id, id));
  }

  if (parsed.procedureId !== undefined) {
    if (parsed.procedureId) {
      // Unlink any procedure previously pointing to this quiz
      await db
        .update(procedures)
        .set({ quizId: null })
        .where(eq(procedures.quizId, id));
      // Link the new procedure
      await db
        .update(procedures)
        .set({ quizId: id })
        .where(eq(procedures.id, parsed.procedureId));
    } else {
      // Unlink
      await db
        .update(procedures)
        .set({ quizId: null })
        .where(eq(procedures.quizId, id));
    }
  }

  const [updated] = await db
    .select()
    .from(quiz)
    .where(eq(quiz.id, id))
    .limit(1);

  if (!updated) {
    throw Object.assign(new ApiError('Quiz not found', 404), {
      errorCode: 'QUIZ_NOT_FOUND',
    });
  }

  const proc = await getProcedureForQuiz(id);

  return {
    ...updated,
    procedureId: proc?.id ?? null,
    procedure: proc,
  };
}

export async function deleteQuiz(id: string): Promise<void> {
  // Unlink quiz from any procedures referencing it
  await db
    .update(procedures)
    .set({ quizId: null })
    .where(eq(procedures.quizId, id));

  const [deleted] = await db
    .delete(quiz)
    .where(eq(quiz.id, id))
    .returning({ id: quiz.id });

  if (!deleted) {
    throw Object.assign(new ApiError('Quiz not found', 404), {
      errorCode: 'QUIZ_NOT_FOUND',
    });
  }
}
