import ApiError from '../../shared/utils/ApiError.ts';
import { logger } from '../../config/logger.ts';
import type {
  ProcedureContextInput,
  ChapterContextInput,
  QuizGenerationConfig,
  GeneratedQuizResult,
  RawAiQuizResponse,
} from './quiz-ai.types.ts';
import {
  extractProcedureContext,
  extractChapterContext,
} from './context-extractor.ts';
import { sanitizeAndValidateQuestions } from './question-sanitizer.ts';
import {
  callOpenAiCompatible,
  buildQuizSystemPrompt,
  buildChapterQuizSystemPrompt,
} from './quiz-ai-prompt.ts';

// Re-export types and schemas for controllers and consumers
export * from './quiz-ai.types.ts';
export {
  extractProcedureContext,
  extractChapterContext,
} from './context-extractor.ts';
export { sanitizeAndValidateQuestions } from './question-sanitizer.ts';

/**
 * Generates a high quality bilingual quiz from procedure context.
 */
export async function generateQuizFromProcedure(
  procedure: ProcedureContextInput,
  configInput?: QuizGenerationConfig,
): Promise<GeneratedQuizResult> {
  const hasBlocksOrIngredients =
    (procedure.blocks && procedure.blocks.length > 0) ||
    (procedure.ingredients && procedure.ingredients.length > 0) ||
    Boolean(procedure.purposeEn && procedure.purposeEn.trim().length >= 15);

  const { contextText, methodStepsCount, hasAttachmentText } =
    await extractProcedureContext(procedure);

  if (!hasBlocksOrIngredients || !contextText || contextText.length < 50) {
    throw new ApiError(
      'Procedure content is too minimal or empty to generate a meaningful quiz. Please add steps or content first.',
      422,
      true,
      '',
      { code: 'PROCEDURE_CONTENT_EMPTY' },
    );
  }

  // Calculate target breakdown & handle edge cases
  const targetMcq = configInput?.mcqCount;
  const targetSeq = configInput?.sequenceCount;
  const targetTotal = configInput?.totalQuestions;
  let advisory: string | null = null;

  let finalMcq: number;
  let finalSeq: number;
  let finalTotal: number;

  if (targetMcq !== undefined && targetSeq !== undefined) {
    if (targetSeq > 0 && methodStepsCount < 2 && !hasAttachmentText) {
      advisory = `Procedure has fewer than 2 sequential steps. ${targetSeq} requested sequence question(s) were automatically converted to multiple choice.`;
      finalMcq = targetMcq + targetSeq;
      finalSeq = 0;
    } else {
      finalMcq = targetMcq;
      finalSeq = targetSeq;
    }
    finalTotal = finalMcq + finalSeq;
  } else if (targetTotal !== undefined) {
    finalTotal = Math.min(10, Math.max(2, targetTotal));
    if (methodStepsCount >= 2 || hasAttachmentText) {
      if (finalTotal <= 3) {
        finalSeq = 1;
        finalMcq = finalTotal - 1;
      } else if (finalTotal <= 5) {
        finalSeq = 2;
        finalMcq = finalTotal - 2;
      } else {
        finalSeq = Math.min(3, Math.floor(finalTotal * 0.35));
        finalMcq = finalTotal - finalSeq;
      }
    } else {
      finalSeq = 0;
      finalMcq = finalTotal;
    }
  } else {
    // Auto Mode (User left as "as you wish", bound between 2 and 10)
    if (methodStepsCount >= 4 || hasAttachmentText) {
      finalTotal = 4;
      finalMcq = 2;
      finalSeq = 2;
    } else if (methodStepsCount >= 2) {
      finalTotal = 3;
      finalMcq = 2;
      finalSeq = 1;
    } else {
      finalTotal = 3;
      finalMcq = 3;
      finalSeq = 0;
    }
  }

  // Final sanity clamp: [2, 10]
  finalTotal = Math.min(10, Math.max(2, finalTotal));

  const systemPrompt = buildQuizSystemPrompt(finalTotal, finalMcq, finalSeq);
  const userPrompt = `PROCEDURE CONTEXT:\n"""\n${contextText}\n"""\n\nGenerate the bilingual quiz now according to the exact requested breakdown (${finalMcq} multiple_choice, ${finalSeq} sequence).`;

  let rawJsonResponse: string;
  try {
    rawJsonResponse = await callOpenAiCompatible([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);
  } catch (err) {
    logger.error(
      { err },
      'Failed to invoke OpenAI/OpenRouter for quiz generation',
    );
    throw err;
  }

  let parsed: RawAiQuizResponse;
  try {
    const cleanJson = rawJsonResponse
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    parsed = JSON.parse(cleanJson);
  } catch (err) {
    logger.error(
      { rawJsonResponse, err },
      'Failed to parse AI quiz JSON response',
    );
    throw new ApiError(
      'AI generated an invalid JSON response for quiz.',
      502,
      true,
      '',
      {
        code: 'AI_INVALID_RESPONSE',
      },
    );
  }

  const titleFallbackEn = procedure.titleEn || 'Procedure Quiz';
  const titleFallbackEs = procedure.titleEs || 'Evaluación del Procedimiento';

  const nameEn = (parsed.nameEn || `${titleFallbackEn} Quiz`)
    .trim()
    .slice(0, 150);
  const nameEs = (parsed.nameEs || `Evaluación de ${titleFallbackEs}`)
    .trim()
    .slice(0, 150);

  const validatedQuestions = sanitizeAndValidateQuestions(parsed.questions, {
    allowSequence: finalSeq > 0,
  });

  // Enforce internal limits: Min 2, Max 10
  if (validatedQuestions.length < 2) {
    throw new ApiError(
      'AI could not generate enough valid questions from the provided procedure content (minimum 2 required). Please add more detailed steps or instructions.',
      422,
      true,
      '',
      { code: 'INSUFFICIENT_QUESTIONS_GENERATED' },
    );
  }

  const finalQuestions = validatedQuestions.slice(0, 10);

  const returnedSeqCount = finalQuestions.filter(
    (q) => q.type === 'sequence',
  ).length;
  if (finalSeq > 0 && returnedSeqCount < finalSeq && !advisory) {
    advisory = `Content only contained enough steps to generate ${returnedSeqCount} sequence question(s). Remaining questions were generated as multiple choice.`;
  }

  return {
    nameEn,
    nameEs,
    questions: finalQuestions,
    advisory,
  };
}

/**
 * Generates a high quality bilingual quiz from course chapter context.
 */
export async function generateQuizFromChapter(
  chapter: ChapterContextInput,
  configInput?: QuizGenerationConfig,
): Promise<GeneratedQuizResult> {
  const { contextText, methodStepsCount, hasAttachmentText } =
    await extractChapterContext(chapter);

  if (!contextText || contextText.length < 30) {
    throw new ApiError(
      'Chapter content is too minimal or empty to generate a meaningful quiz. Please add lesson content, steps, or documents first.',
      422,
      true,
      '',
      { code: 'CHAPTER_CONTENT_EMPTY' },
    );
  }

  // Calculate target breakdown & handle edge cases
  const targetMcq = configInput?.mcqCount;
  const targetSeq = configInput?.sequenceCount;
  const targetTotal = configInput?.totalQuestions;
  let advisory: string | null = null;

  let finalMcq: number;
  let finalSeq: number;
  let finalTotal: number;

  if (targetMcq !== undefined && targetSeq !== undefined) {
    if (targetSeq > 0 && methodStepsCount < 2 && !hasAttachmentText) {
      advisory = `Chapter has fewer than 2 sequential steps. ${targetSeq} requested sequence question(s) were automatically converted to multiple choice.`;
      finalMcq = targetMcq + targetSeq;
      finalSeq = 0;
    } else {
      finalMcq = targetMcq;
      finalSeq = targetSeq;
    }
    finalTotal = finalMcq + finalSeq;
  } else if (targetTotal !== undefined) {
    finalTotal = Math.min(10, Math.max(2, targetTotal));
    if (methodStepsCount >= 2 || hasAttachmentText) {
      if (finalTotal <= 3) {
        finalSeq = 1;
        finalMcq = finalTotal - 1;
      } else if (finalTotal <= 5) {
        finalSeq = 2;
        finalMcq = finalTotal - 2;
      } else {
        finalSeq = Math.min(3, Math.floor(finalTotal * 0.35));
        finalMcq = finalTotal - finalSeq;
      }
    } else {
      finalSeq = 0;
      finalMcq = finalTotal;
    }
  } else {
    // Auto Mode
    if (methodStepsCount >= 4 || hasAttachmentText) {
      finalTotal = 4;
      finalMcq = 2;
      finalSeq = 2;
    } else if (methodStepsCount >= 2) {
      finalTotal = 3;
      finalMcq = 2;
      finalSeq = 1;
    } else {
      finalTotal = 3;
      finalMcq = 3;
      finalSeq = 0;
    }
  }

  // Final sanity clamp: [2, 10]
  finalTotal = Math.min(10, Math.max(2, finalTotal));

  const systemPrompt = buildChapterQuizSystemPrompt(
    finalTotal,
    finalMcq,
    finalSeq,
    chapter.courseName,
    chapter.chapterNumber,
  );
  const userPrompt = `CHAPTER CONTEXT:\n"""\n${contextText}\n"""\n\nGenerate the bilingual quiz now according to the exact requested breakdown (${finalMcq} multiple_choice, ${finalSeq} sequence).`;

  logger.info(
    {
      userPromptLength: userPrompt.length,
      contextSnippet: contextText.slice(0, 400),
    },
    'generateQuizFromChapter: Calling AI model with chapter context',
  );

  let rawJsonResponse: string;
  try {
    rawJsonResponse = await callOpenAiCompatible([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);
  } catch (err) {
    logger.error(
      { err },
      'Failed to invoke OpenAI/OpenRouter for chapter quiz generation',
    );
    throw err;
  }

  let parsed: RawAiQuizResponse;
  try {
    const cleanJson = rawJsonResponse
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    parsed = JSON.parse(cleanJson);
  } catch (err) {
    logger.error(
      { rawJsonResponse, err },
      'Failed to parse AI chapter quiz JSON response',
    );
    throw new ApiError(
      'AI generated an invalid JSON response for chapter quiz.',
      502,
      true,
      '',
      {
        code: 'AI_INVALID_RESPONSE',
      },
    );
  }

  const titleFallbackEn = chapter.titleEn || 'Chapter Quiz';
  const titleFallbackEs = chapter.titleEs || 'Evaluación del Capítulo';

  const nameEn = (parsed.nameEn || `${titleFallbackEn} Quiz`)
    .trim()
    .slice(0, 150);
  const nameEs = (parsed.nameEs || `Evaluación de ${titleFallbackEs}`)
    .trim()
    .slice(0, 150);

  const validatedQuestions = sanitizeAndValidateQuestions(parsed.questions, {
    allowSequence: finalSeq > 0,
  });

  // Enforce internal limits: Min 2, Max 10
  if (validatedQuestions.length < 2) {
    throw new ApiError(
      'AI could not generate enough valid questions from the provided chapter content (minimum 2 required). Please add more detailed lessons, steps, or documents.',
      422,
      true,
      '',
      { code: 'INSUFFICIENT_QUESTIONS_GENERATED' },
    );
  }

  const finalQuestions = validatedQuestions.slice(0, 10);

  const returnedSeqCount = finalQuestions.filter(
    (q) => q.type === 'sequence',
  ).length;
  if (finalSeq > 0 && returnedSeqCount < finalSeq && !advisory) {
    advisory = `Content only contained enough steps to generate ${returnedSeqCount} sequence question(s). Remaining questions were generated as multiple choice.`;
  }

  return {
    nameEn,
    nameEs,
    questions: finalQuestions,
    advisory,
  };
}
