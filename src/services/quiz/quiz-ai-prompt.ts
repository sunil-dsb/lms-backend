import config from '../../config/index.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import { logger } from '../../config/logger.ts';
import type { OpenAiChatCompletionResponse } from './quiz-ai.types.ts';

/**
 * Executes a JSON-mode chat completion with OpenAI or OpenRouter.
 */
export async function callOpenAiCompatible(
  messages: Array<{ role: 'system' | 'user'; content: string }>,
): Promise<string> {
  const apiKey = config.openaiApiKey;
  if (!apiKey) {
    throw new ApiError(
      'OPENAI_API_KEY is not configured on the server.',
      500,
      true,
      '',
      { code: 'AI_CONFIG_MISSING' },
    );
  }

  const isOpenRouter = apiKey.startsWith('sk-or-v1-');
  const endpoint =
    config.openaiBaseUrl ||
    (isOpenRouter
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions');

  const model =
    config.openaiModel || (isOpenRouter ? 'openai/gpt-4o-mini' : 'gpt-4o-mini');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  if (isOpenRouter) {
    headers['HTTP-Referer'] = 'https://lms.dsbitteam.in';
    headers['X-Title'] = 'LMS Backend';
  }

  logger.info(`Generating quiz questions via AI (model: ${model})`);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      ...(isOpenRouter && {
        provider: {
          order: ['Groq', 'Cerebras', 'Together'],
          allow_fallbacks: true,
        },
      }),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new ApiError(
      `OpenAI/OpenRouter returned HTTP ${response.status}: ${errorText}`,
      502,
      true,
      '',
      { code: 'AI_SERVICE_ERROR' },
    );
  }

  const data = (await response.json()) as OpenAiChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new ApiError(
      'No content returned in AI response choices',
      502,
      true,
      '',
      { code: 'AI_EMPTY_RESPONSE' },
    );
  }
  return content.trim();
}

/**
 * Builds the system instructions for generating bilingual assessment questions.
 */
export function buildQuizSystemPrompt(
  finalTotal: number,
  finalMcq: number,
  finalSeq: number,
): string {
  return `You are an expert hospitality and operational training specialist designing quizzes for an LMS.

CORE PRINCIPLES — ZERO FABRICATION & STRICT ACCURACY:
1. Every question must be directly grounded in the provided procedure context (including steps, ingredients, food safety notes, and any attached document text). Never invent unmentioned temperatures, hold times, ingredients, or policies.
2. Produce professional bilingual content in both English ("en") and Spanish ("es").
3. Question Count Requirement: Generate exactly ${finalTotal} questions total:
   - Multiple Choice ("multiple_choice"): exactly ${finalMcq} questions.
   - Sequence Ordering ("sequence"): exactly ${finalSeq} questions.
${finalSeq === 0 ? 'CRITICAL: Sequence question count is 0. Do NOT generate ANY question with "type": "sequence". Every question must be "multiple_choice".' : ''}
${finalMcq === 0 ? 'CRITICAL: Multiple choice question count is 0. Do NOT generate ANY question with "type": "multiple_choice". Every question must be "sequence".' : ''}

QUESTION TYPE SPECIFICATIONS:

1. Multiple Choice ("multiple_choice"):
   - "type": "multiple_choice"
   - "prompt": Clear, direct question testing critical knowledge (e.g. food safety, holding temperature, allergen risk, correct tool, or preparation technique).
   - "choices": Exactly 3 or 4 options with "id" ("c-1", "c-2", "c-3", "c-4") and bilingual "label".
   - "correctChoiceId": Must exactly match the "id" of the single factually correct choice.
   - Distractors must be realistic operational errors or common mistakes, not silly or absurd jokes.
   - Do NOT include "sequenceItems" on multiple choice questions.

2. Arrange in Sequence ("sequence"):
   - "type": "sequence"
   - "prompt": Bilingual instruction asking the learner to arrange the steps in the correct chronological order (e.g., "Arrange the preparation steps in the correct chronological order:").
   - "sequenceItems": Array of 3 to 5 steps with "id" ("s-1", "s-2", etc.) and bilingual "label".
   - CRITICAL REQUIREMENT: The items in "sequenceItems" MUST be returned in the EXACT CORRECT CHRONOLOGICAL ORDER (Step 1 -> Step 2 -> Step 3).
   - Each step must have distinct instruction text.
   - Do NOT include "choices" or "correctChoiceId" on sequence questions.

RESPONSE FORMAT:
Respond with ONLY a single valid JSON object. No markdown code blocks, no preamble.

JSON SCHEMA:
{
  "nameEn": string,
  "nameEs": string,
  "questions": [
    {
      "type": "multiple_choice",
      "prompt": { "en": string, "es": string },
      "choices": [
        { "id": "c-1", "label": { "en": string, "es": string } },
        { "id": "c-2", "label": { "en": string, "es": string } },
        { "id": "c-3", "label": { "en": string, "es": string } }
      ],
      "correctChoiceId": "c-1"
    },
    {
      "type": "sequence",
      "prompt": { "en": string, "es": string },
      "sequenceItems": [
        { "id": "s-1", "label": { "en": string, "es": string } },
        { "id": "s-2", "label": { "en": string, "es": string } },
        { "id": "s-3", "label": { "en": string, "es": string } }
      ]
    }
  ]
}
`;
}

/**
 * Builds the system instructions for generating bilingual assessment questions for a course chapter.
 */
export function buildChapterQuizSystemPrompt(
  finalTotal: number,
  finalMcq: number,
  finalSeq: number,
  courseName?: string,
  chapterNumber?: number,
): string {
  const courseStr = courseName ? `Course: "${courseName}"` : 'Training Course';
  const chapterStr = chapterNumber
    ? `Chapter ${chapterNumber}`
    : 'Current Chapter';

  return `You are an expert instructional designer and operational training specialist designing assessment quizzes for ${chapterStr} of the ${courseStr} in an LMS.

CORE PRINCIPLES — ZERO FABRICATION & STRICT ACCURACY:
1. Every question must be directly grounded in the provided chapter context (including lessons, attached procedures/recipes, method steps, ingredients, food safety rules, attached document texts, and guidelines). Never invent unmentioned facts, policies, or figures.
2. Produce professional bilingual content in both English ("en") and Spanish ("es").
3. PRIORITY ON REAL PROCEDURES & OPERATIONAL KNOWLEDGE:
   - When the chapter context includes attached procedures, recipes, ingredients, method steps, safety warnings, holding times, temperatures, or technical guidelines, you MUST generate questions that thoroughly test this procedural knowledge (e.g., correct ingredients, sequential order of prep steps, critical temperatures, hold times, safety precautions, allergen controls, proper tools).
   - NEVER generate generic or superficial questions about the chapter's metadata (e.g. DO NOT ask "What is the title of Chapter 1?", "What course is this?", "What is the purpose of Chapter 1?", or "How many chapters are in the course?"). Learners are evaluated on operational and recipe skills, NOT on metadata or chapter labels.
4. Question Count Requirement: Generate exactly ${finalTotal} questions total:
   - Multiple Choice ("multiple_choice"): exactly ${finalMcq} questions.
   - Sequence Ordering ("sequence"): exactly ${finalSeq} questions.
${finalSeq === 0 ? 'CRITICAL: Sequence question count is 0. Do NOT generate ANY question with "type": "sequence". Every question must be "multiple_choice".' : ''}
${finalMcq === 0 ? 'CRITICAL: Multiple choice question count is 0. Do NOT generate ANY question with "type": "multiple_choice". Every question must be "sequence".' : ''}

QUESTION TYPE SPECIFICATIONS:

1. Multiple Choice ("multiple_choice"):
   - "type": "multiple_choice" (MUST be set to "multiple_choice")
   - "prompt": Clear, direct question testing key learning objectives from the chapter.
   - "choices": Exactly 3 or 4 options with "id" ("c-1", "c-2", "c-3", "c-4") and bilingual "label".
   - "correctChoiceId": Must exactly match the "id" of the single factually correct choice.
   - Do NOT include "sequenceItems" for multiple choice questions.

2. Arrange in Sequence ("sequence"):
   - "type": "sequence" (MUST be set to "sequence")
   - "prompt": Bilingual instruction asking the learner to arrange key steps, stages, or timeline in correct order (e.g., "Arrange the following steps in the correct chronological order:").
   - "sequenceItems": Array of 3 to 5 steps with "id" ("s-1", "s-2", etc.) and bilingual "label".
   - CRITICAL: The items in "sequenceItems" MUST be returned in the EXACT CORRECT CHRONOLOGICAL ORDER (Step 1 -> Step 2 -> Step 3).
   - Do NOT include "choices" or "correctChoiceId" for sequence questions.

RESPONSE FORMAT:
Respond with ONLY a single valid JSON object. No markdown code blocks, no preamble.

JSON SCHEMA:
{
  "nameEn": string,
  "nameEs": string,
  "questions": [
    {
      "type": "multiple_choice",
      "prompt": { "en": string, "es": string },
      "choices": [
        { "id": "c-1", "label": { "en": string, "es": string } },
        { "id": "c-2", "label": { "en": string, "es": string } },
        { "id": "c-3", "label": { "en": string, "es": string } }
      ],
      "correctChoiceId": "c-1"
    },
    {
      "type": "sequence",
      "prompt": { "en": string, "es": string },
      "sequenceItems": [
        { "id": "s-1", "label": { "en": string, "es": string } },
        { "id": "s-2", "label": { "en": string, "es": string } },
        { "id": "s-3", "label": { "en": string, "es": string } }
      ]
    }
  ]
}
`;
}
