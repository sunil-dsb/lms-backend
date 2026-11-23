import crypto from 'node:crypto';
import { logger } from '../../config/logger.ts';
import {
  quizQuestionSchema,
  type QuizQuestion,
} from '../../db/schema/quiz.schema.ts';
import type { RawAiQuestion } from './quiz-ai.types.ts';

/**
 * Normalizes raw LLM questions, generating valid UUIDs and enforcing strict Zod validation.
 */
export function sanitizeAndValidateQuestions(
  rawQuestions: RawAiQuestion[] | undefined,
  options?: { allowSequence?: boolean },
): QuizQuestion[] {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return [];
  }

  const allowSequence = options?.allowSequence ?? true;
  const validQuestions: QuizQuestion[] = [];

  for (const raw of rawQuestions) {
    const qId = crypto.randomUUID();
    const rawPromptEn =
      raw.prompt?.en?.trim() || raw.question?.en?.trim() || '';
    const rawPromptEs =
      raw.prompt?.es?.trim() || raw.question?.es?.trim() || '';

    const isExplicitSequence = raw.type === 'sequence';
    const isPromptSequence = Boolean(
      (rawPromptEn &&
        /arrange.*(step|order)|chronological|sequence/i.test(rawPromptEn)) ||
      (rawPromptEs &&
        /organiza.*(paso|orden)|cronol[oó]gico|secuencia/i.test(rawPromptEs)),
    );
    const hasSequenceItems =
      Array.isArray(raw.sequenceItems) && raw.sequenceItems.length >= 2;

    // A question is sequence if explicitly marked as sequence, if prompt is an arrangement prompt, or if it has sequence items
    const isSequence =
      allowSequence &&
      (isExplicitSequence || isPromptSequence || hasSequenceItems);

    if (isSequence) {
      // Validate sequence items — fall back to choices array if the LLM put the sequence steps in choices
      const rawItems =
        Array.isArray(raw.sequenceItems) && raw.sequenceItems.length > 0
          ? raw.sequenceItems
          : Array.isArray(raw.choices)
            ? raw.choices
            : [];

      const sanitizedItems: Array<{
        id: string;
        label: { en: string; es: string };
      }> = [];
      const seenLabels = new Set<string>();

      for (let i = 0; i < rawItems.length; i++) {
        const item: unknown = rawItems[i];
        let en = '';
        let es = '';

        if (typeof item === 'string') {
          en = item.trim();
          es = item.trim();
        } else if (item && typeof item === 'object') {
          const itemObj = item as Record<string, unknown>;
          if (itemObj.label && typeof itemObj.label === 'object') {
            const l = itemObj.label as Record<string, unknown>;
            en = typeof l.en === 'string' ? l.en.trim() : '';
            es = typeof l.es === 'string' ? l.es.trim() : '';
          } else if (typeof itemObj.label === 'string') {
            en = itemObj.label.trim();
            es = itemObj.label.trim();
          } else if (itemObj.text && typeof itemObj.text === 'object') {
            const t = itemObj.text as Record<string, unknown>;
            en = typeof t.en === 'string' ? t.en.trim() : '';
            es = typeof t.es === 'string' ? t.es.trim() : '';
          } else if (typeof itemObj.text === 'string') {
            en = itemObj.text.trim();
            es = itemObj.text.trim();
          } else {
            en = typeof itemObj.en === 'string' ? itemObj.en.trim() : '';
            es = typeof itemObj.es === 'string' ? itemObj.es.trim() : '';
          }
        }

        if (!en && !es) continue;

        // Skip exact duplicate text steps
        const key = `${en.toLowerCase()}|||${es.toLowerCase()}`;
        if (seenLabels.has(key)) continue;
        seenLabels.add(key);

        sanitizedItems.push({
          id: crypto.randomUUID(),
          label: {
            en: en || es,
            es: es || en,
          },
        });
      }

      // Minimum 2 distinct steps required by LMS schema
      if (sanitizedItems.length >= 2) {
        const defaultPromptEn =
          'Arrange the preparation steps in the correct chronological order:';
        const defaultPromptEs =
          'Organiza los pasos de preparación en el orden cronológico correcto:';

        const qCandidate = {
          id: qId,
          type: 'sequence' as const,
          prompt: {
            en: rawPromptEn || defaultPromptEn,
            es: rawPromptEs || defaultPromptEs,
          },
          sequenceItems: sanitizedItems.slice(0, 8), // cap individual sequence to 8 steps max
        };

        const parsed = quizQuestionSchema.safeParse(qCandidate);
        if (parsed.success) {
          validQuestions.push(parsed.data);
        } else {
          logger.warn(
            { issues: parsed.error.issues },
            'Sequence question failed schema validation',
          );
        }
      }
    } else {
      // Multiple Choice
      const rawChoices = Array.isArray(raw.choices) ? raw.choices : [];
      const sanitizedChoices: Array<{
        id: string;
        label: { en: string; es: string };
      }> = [];
      let correctChoiceId = '';

      // Match designated correctChoiceId if present
      const rawCorrectId = raw.correctChoiceId?.trim();

      for (let i = 0; i < rawChoices.length; i++) {
        const c: unknown = rawChoices[i];
        let en = '';
        let es = '';
        let candidateId = '';

        if (typeof c === 'string') {
          en = c.trim();
          es = c.trim();
        } else if (c && typeof c === 'object') {
          const cObj = c as Record<string, unknown>;
          candidateId = typeof cObj.id === 'string' ? cObj.id.trim() : '';

          if (cObj.label && typeof cObj.label === 'object') {
            const l = cObj.label as Record<string, unknown>;
            en = typeof l.en === 'string' ? l.en.trim() : '';
            es = typeof l.es === 'string' ? l.es.trim() : '';
          } else if (typeof cObj.label === 'string') {
            en = cObj.label.trim();
            es = cObj.label.trim();
          } else if (cObj.text && typeof cObj.text === 'object') {
            const t = cObj.text as Record<string, unknown>;
            en = typeof t.en === 'string' ? t.en.trim() : '';
            es = typeof t.es === 'string' ? t.es.trim() : '';
          } else if (typeof cObj.text === 'string') {
            en = cObj.text.trim();
            es = cObj.text.trim();
          } else {
            en = typeof cObj.en === 'string' ? cObj.en.trim() : '';
            es = typeof cObj.es === 'string' ? cObj.es.trim() : '';
          }
        }

        if (!en && !es) continue;

        const choiceId = crypto.randomUUID();
        sanitizedChoices.push({
          id: choiceId,
          label: {
            en: en || es,
            es: es || en,
          },
        });

        if (
          candidateId &&
          (candidateId === rawCorrectId || rawCorrectId?.includes(candidateId))
        ) {
          correctChoiceId = choiceId;
        }
      }

      // Multiple choice questions strictly require at least 2 non-empty choices
      const validChoices = sanitizedChoices.filter((c) =>
        Boolean(c.label.en.trim() || c.label.es.trim()),
      );

      // If correctChoiceId was not matched, fallback to the first choice
      if (
        !validChoices.some((c) => c.id === correctChoiceId) &&
        validChoices.length > 0
      ) {
        correctChoiceId = validChoices[0]!.id;
      }

      if (validChoices.length >= 2 && (rawPromptEn || rawPromptEs)) {
        const qCandidate = {
          id: qId,
          type: 'multiple_choice' as const,
          prompt: {
            en: rawPromptEn || rawPromptEs,
            es: rawPromptEs || rawPromptEn,
          },
          choices: validChoices.slice(0, 5), // cap at 5 options max
          correctChoiceId,
        };

        const parsed = quizQuestionSchema.safeParse(qCandidate);
        if (parsed.success) {
          validQuestions.push(parsed.data);
        } else {
          logger.warn(
            { issues: parsed.error.issues },
            'MCQ question failed schema validation',
          );
        }
      }
    }
  }

  return validQuestions;
}
