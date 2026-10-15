import config from '../../config/index.ts';
import ApiError from '../../shared/utils/ApiError.ts';
import { logger } from '../../config/logger.ts';
import {
  procedureBodySchema,
  type Block,
  type CreateProcedureInput,
  type ProcedureBody,
} from '../../db/procedure.schema.ts';

export interface ExtractedBlockRaw {
  id?: string;
  kind?:
    | 'text'
    | 'heading'
    | 'method'
    | 'warning'
    | 'checklist'
    | 'table'
    | 'ingredients'
    | 'attachment'
    | 'image'
    | 'video';
  level?: 1 | 2 | 3;
  text?: { en?: string; es?: string };
  body?: { en?: string; es?: string };
  severity?: 'warn' | 'tip' | 'alt' | 'equip' | 'allergen';
  title?: { en?: string; es?: string };
  items?: Array<{ id?: string; text?: { en?: string; es?: string } }>;
  headers?: Array<{ en?: string; es?: string }>;
  rows?: Array<Array<{ en?: string; es?: string }>>;
  factors?: number[];
  ingredients?: Array<{
    name: string;
    form?: string;
    unit?: string;
    amount?: string;
    amounts?: string[];
    allergen?: boolean;
  }>;
  steps?: Array<{
    id?: string;
    body?: { en?: string; es?: string };
  }>;
  src?: string;
  alt?: { en?: string; es?: string };
  caption?: { en?: string; es?: string };
  href?: string;
  meta?: string;
}

interface ExtractedAiResponse {
  isValidProcedure?: boolean;
  rejectionReason?: string | null;
  titleEn?: string;
  titleEs?: string;
  purposeEn?: string;
  purposeEs?: string;
  blocks?: ExtractedBlockRaw[];
}

/**
 * Builds valid ProcedureBody objects ensuring all blocks strictly adhere
 * to procedureBodySchema and LMS localisedString invariants.
 */
function normalizeProcedureBlocks(rawBlocks?: ExtractedBlockRaw[]): {
  bodyEn: ProcedureBody;
  bodyEs: ProcedureBody;
} {
  const blocks: Block[] = [];

  if (Array.isArray(rawBlocks) && rawBlocks.length > 0) {
    let blockCounter = 1;

    for (const b of rawBlocks) {
      const id = b.id || `blk-${blockCounter++}`;

      switch (b.kind) {
        case 'heading': {
          if (b.text?.en || b.text?.es) {
            blocks.push({
              id,
              kind: 'heading',
              level: b.level && [1, 2, 3].includes(b.level) ? b.level : 2,
              text: {
                en: (b.text.en || b.text.es || 'Section').trim(),
                es: (b.text.es || b.text.en || 'Sección').trim(),
              },
            });
          }
          break;
        }

        case 'warning': {
          const allowedSeverities = [
            'warn',
            'tip',
            'alt',
            'equip',
            'allergen',
          ] as const;
          const severity =
            b.severity && allowedSeverities.includes(b.severity)
              ? b.severity
              : 'warn';
          blocks.push({
            id,
            kind: 'warning',
            severity,
            body: {
              en: (b.body?.en || b.body?.es || 'Safety note').trim(),
              es: (b.body?.es || b.body?.en || 'Nota de seguridad').trim(),
            },
          });
          break;
        }

        case 'checklist': {
          const rawItems = Array.isArray(b.items) ? b.items : [];
          let checkCounter = 1;
          const validItems = rawItems
            .filter((it) => it.text?.en || it.text?.es)
            .map((it) => ({
              id: it.id || `chk-${checkCounter++}`,
              text: {
                en: (it.text?.en || it.text?.es || 'Checklist item').trim(),
                es: (it.text?.es || it.text?.en || 'Elemento de lista').trim(),
              },
            }));

          if (validItems.length > 0) {
            blocks.push({
              id,
              kind: 'checklist',
              title: {
                en: (
                  b.title?.en ||
                  b.title?.es ||
                  'Verification Checklist'
                ).trim(),
                es: (
                  b.title?.es ||
                  b.title?.en ||
                  'Lista de Verificación'
                ).trim(),
              },
              items: validItems,
            });
          }
          break;
        }

        case 'table': {
          const rawHeaders = Array.isArray(b.headers) ? b.headers : [];
          const validHeaders = rawHeaders
            .filter((h) => h.en || h.es)
            .map((h) => ({
              en: (h.en || h.es || 'Column').trim(),
              es: (h.es || h.en || 'Columna').trim(),
            }));

          if (validHeaders.length > 0) {
            const rawRows = Array.isArray(b.rows) ? b.rows : [];
            const validRows = rawRows.map((row) => {
              const cells = Array.isArray(row) ? row : [];
              return validHeaders.map((_, colIdx) => {
                const cell = cells[colIdx];
                return {
                  en: (cell?.en || cell?.es || '-').trim(),
                  es: (cell?.es || cell?.en || '-').trim(),
                };
              });
            });

            blocks.push({
              id,
              kind: 'table',
              headers: validHeaders,
              rows: validRows,
            });
          }
          break;
        }

        case 'ingredients': {
          const rawIngredients = Array.isArray(b.ingredients)
            ? b.ingredients
            : [];
          if (rawIngredients.length > 0) {
            const factors = [1];
            const validIngredients = rawIngredients.map((ing) => {
              const amountStr = (
                ing.amount ||
                (ing.amounts && ing.amounts[0]) ||
                'As needed'
              ).trim();
              return {
                name: (ing.name || 'Ingredient').trim(),
                form: ing.form?.trim() || undefined,
                unit: ing.unit?.trim() || undefined,
                allergen: Boolean(ing.allergen),
                amounts: [amountStr],
              };
            });

            blocks.push({
              id,
              kind: 'ingredients',
              factors,
              ingredients: validIngredients,
            });
          }
          break;
        }

        case 'method': {
          const rawSteps = Array.isArray(b.steps) ? b.steps : [];
          let stepCounter = 1;
          const validSteps = rawSteps
            .filter((s) => s.body?.en || s.body?.es)
            .map((s) => ({
              id: s.id || `step-${stepCounter++}`,
              body: {
                en: (s.body?.en || s.body?.es || 'Step details').trim(),
                es: (s.body?.es || s.body?.en || 'Detalles del paso').trim(),
              },
            }));

          if (validSteps.length > 0) {
            blocks.push({
              id,
              kind: 'method',
              steps: validSteps,
            });
          }
          break;
        }
        case 'attachment': {
          if (b.href && (b.title?.en || b.title?.es)) {
            blocks.push({
              id,
              kind: 'attachment',
              title: {
                en: (b.title.en || b.title.es || 'Attachment').trim(),
                es: (b.title.es || b.title.en || 'Adjunto').trim(),
              },
              href: b.href.trim(),
              meta: b.meta?.trim() || undefined,
            });
          }
          break;
        }

        case 'image': {
          if (
            b.src &&
            (b.alt?.en || b.alt?.es || b.caption?.en || b.caption?.es)
          ) {
            blocks.push({
              id,
              kind: 'image',
              src: b.src.trim(),
              alt: {
                en: (b.alt?.en || b.alt?.es || 'Image').trim(),
                es: (b.alt?.es || b.alt?.en || 'Imagen').trim(),
              },
              caption:
                b.caption?.en || b.caption?.es
                  ? {
                      en: b.caption.en?.trim() || undefined,
                      es: b.caption.es?.trim() || undefined,
                    }
                  : undefined,
              hint: 'photo',
            });
          }
          break;
        }

        case 'video': {
          if (b.src) {
            try {
              new URL(b.src);
              blocks.push({
                id,
                kind: 'video',
                src: b.src.trim(),
                caption: {
                  en: b.caption?.en?.trim() || '',
                  es: b.caption?.es?.trim() || '',
                },
              });
            } catch {
              // Ignore invalid video URL
            }
          }
          break;
        }

        case 'text':
        default: {
          if (b.body?.en || b.body?.es) {
            blocks.push({
              id,
              kind: 'text',
              body: {
                en: (b.body.en || b.body.es || 'Content').trim(),
                es: (b.body.es || b.body.en || 'Contenido').trim(),
              },
            });
          }
          break;
        }
      }
    }
  }

  // Ensure there is at least one block
  if (blocks.length === 0) {
    blocks.push({
      id: 'blk-initial-1',
      kind: 'text',
      body: {
        en: 'Imported draft procedure content.',
        es: 'Contenido de procedimiento borrador importado.',
      },
    });
  }

  const procedureBody: ProcedureBody = { blocks };
  const validated = procedureBodySchema.parse(procedureBody);

  return {
    bodyEn: validated,
    bodyEs: validated,
  };
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

/**
 * Calls OpenAI or OpenRouter depending on API key prefix and configuration.
 */
async function callOpenAiCompatible(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<string> {
  const apiKey = config.openaiApiKey;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
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

  logger.info(
    `Attempting AI extraction via OpenAI/OpenRouter (model: ${model})`,
  );

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.1,
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
    throw new Error(
      `OpenAI/OpenRouter returned HTTP ${response.status}: ${errorText}`,
    );
  }

  const data = (await response.json()) as OpenAiChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No content returned in OpenAI response choices');
  }
  return content.trim();
}

/**
 * Calls OpenAI/OpenRouter to extract title, purpose, and structured procedure blocks
 * in both English and Spanish from raw document text.
 */
export async function extractProcedureFieldsWithAi(
  rawDocumentText: string,
): Promise<
  Pick<
    CreateProcedureInput,
    'titleEn' | 'titleEs' | 'purposeEn' | 'purposeEs' | 'bodyEn' | 'bodyEs'
  >
> {
  if (!config.openaiApiKey) {
    throw new ApiError(
      'OPENAI_API_KEY is not configured on the server.',
      500,
      true,
      '',
      { code: 'AI_CONFIG_MISSING' },
    );
  }

  const systemPrompt = `You are an AI document parser and restructuring assistant for an LMS procedure system.

PRIMARY MANDATE — ZERO CONTENT FABRICATION / STRICT FAITHFULNESS:
1. Extract and structure ONLY what is explicitly provided in the source text. NEVER invent, extrapolate, hypothesize, or add steps, ingredients, tools, warnings, or checklist items not present in the document.
2. If the user provides only a brief phrase, title, or single instruction (e.g., "Cut avacado"), generate ONLY that single instruction. Do NOT invent prior preparation steps (washing, peeling), subsequent steps (plating, seasoning, storage), ingredients (avocado, salt, lime), or safety warnings.
3. If no ingredients are listed in the input text, DO NOT output an "ingredients" block.
4. If no safety warnings or alerts are in the input text, DO NOT output a "warning" block.
5. If no checklists are in the input text, DO NOT output a "checklist" block.
6. If no tables are in the input text, DO NOT output a "table" block.

DOCUMENT CONTENT VALIDITY CHECK:
Verify whether the input document contains legitimate operational, instructional, or procedural content (e.g., recipes, preparation steps, SOPs, onboarding, equipment guides, food safety, cleaning rules, or operational tasks).
- If the document contains random keyboard gibberish (e.g., "gdhgdsjahdkadacscsdd"), programming source code (e.g., "import { ... } from '...'"), arbitrary system logs, or completely lacks any meaningful operational instruction or recipe:
  Set "isValidProcedure": false
  Set "rejectionReason": "The document contains invalid or non-operational content (such as source code or random text) and cannot be imported as a procedure."
  Set "titleEn": "Invalid Document"
  Set "titleEs": "Documento Inválido"
  Set "purposeEn": ""
  Set "purposeEs": ""
  Set "blocks": []
- If the document contains legitimate procedure or recipe content (even a brief instruction like "Clean your hands" or "Cut avocado"):
  Set "isValidProcedure": true
  Set "rejectionReason": null
  Extract fields and blocks faithfully.

PERMITTED AND REQUIRED ENHANCEMENTS:
1. Fix any spelling and typographical errors in the input text (e.g., "avacado" -> "avocado", "recpie" -> "recipe", "temprature" -> "temperature").
2. Improve vocabulary, grammar, clarity, and phrasing of the provided text while strictly keeping its exact scope and meaning unchanged.
3. Provide accurate and natural bilingual translations for both English ("en") and Spanish ("es").
4. Derive a concise Title ("titleEn" and "titleEs") directly from the provided text (max 150 chars).
5. Derive a brief Purpose ("purposeEn" and "purposeEs") summarizing ONLY what is described in the text (1-2 sentences). Do not invent unmentioned goals, business policies, or operational standards.
6. Map the provided text faithfully into the matching block schema below.

OUTPUT FORMAT:
Respond ONLY with a single valid JSON object. No markdown code fences, no introductory or concluding text.

JSON SCHEMA:
{
  "isValidProcedure": boolean,    // true if legitimate procedure/recipe/instruction, false if code/gibberish
  "rejectionReason": string|null, // explanation if isValidProcedure is false, otherwise null
  "titleEn": string,              // Concise procedure title derived directly from the text (max 150 chars)
  "titleEs": string,              // Same title translated to Spanish
  "purposeEn": string,            // 1-2 sentence purpose statement derived strictly from the text
  "purposeEs": string,            // Same purpose translated to Spanish
  "blocks": Block[]               // Content blocks containing ONLY the information present in the input text
}

SUPPORTED BLOCK SCHEMAS (use ONLY the block types that match the document content):
- Text (DEFAULT for general text, paragraphs, notes, or unnumbered sentences):
  Use "text" for any unnumbered sentence, note, policy, or text that does not have explicit step numbers.
  { "id": string, "kind": "text", "body": { "en": string, "es": string } }
- Method (ONLY for explicitly numbered or sequential step-by-step instructions):
  Use "method" ONLY when the document explicitly has numbered steps (e.g., "1.", "2."), "Step X:" labels, or multiple sequential steps. NEVER use "method" for a plain sentence or single unnumbered phrase.
  { "id": string, "kind": "method", "steps": [{ "id": string, "body": { "en": string, "es": string } }] }
- Heading (use for section titles and topic headers in the document, e.g. "Preparation", "Taste & Adjust", "Plating", "Storage", "Equipment"):
  When the document contains section headers introducing or dividing steps, policies, or topics, preserve each as a "heading" block (level 2) immediately before the corresponding content or method steps. Do not discard or drop section titles.
  { "id": string, "kind": "heading", "level": 1|2|3, "text": { "en": string, "es": string } }
- Ingredients (ONLY if the document explicitly lists ingredients with quantities):
  { "id": string, "kind": "ingredients", "ingredients": [{ "name": string, "amount": string, "unit": string, "allergen": boolean }] }
- Warning (ONLY if the document explicitly specifies safety warnings or alerts):
  { "id": string, "kind": "warning", "severity": "warn"|"tip"|"equip"|"allergen", "body": { "en": string, "es": string } }
- Checklist (ONLY if the document explicitly has checklist or audit items):
  { "id": string, "kind": "checklist", "title": { "en": string, "es": string }, "items": [{ "id": string, "text": { "en": string, "es": string } }] }
- Table (ONLY if the document explicitly contains tabular data):
  { "id": string, "kind": "table", "headers": [{ "en": string, "es": string }], "rows": [[{ "en": string, "es": string }]] }

CONCRETE EXAMPLES:

Example 1 — Plain text / unnumbered input:
Input: "Clean your hand"
Expected output:
{
  "titleEn": "Clean Hands",
  "titleEs": "Limpieza de Manos",
  "purposeEn": "Guidelines for cleaning hands.",
  "purposeEs": "Pautas para la limpieza de manos.",
  "blocks": [
    {
      "id": "blk-1",
      "kind": "text",
      "body": {
        "en": "Clean your hands thoroughly.",
        "es": "Lávese bien las manos."
      }
    }
  ]
}
Notice that because the input has no step numbers ("1.", "2.") or "Step X:", it is structured as a "text" block, NOT a "method" block.

Example 2 — Numbered steps:
Input: "1. Cut avacado in half. 2. Remove pit."
Expected output:
{
  "titleEn": "Cut Avocado",
  "titleEs": "Cortar Aguacate",
  "purposeEn": "Procedure for cutting an avocado and removing the pit.",
  "purposeEs": "Procedimiento para cortar un aguacate y retirar el hueso.",
  "blocks": [
    {
      "id": "blk-1",
      "kind": "method",
      "steps": [
        {
          "id": "step-1",
          "body": {
            "en": "Cut the avocado in half.",
            "es": "Corte el aguacate por la mitad."
          }
        },
        {
          "id": "step-2",
          "body": {
            "en": "Remove the pit.",
            "es": "Retire el hueso."
          }
        }
      ]
    }
  ]
}
Notice that NO extra unmentioned steps, ingredients, or warnings were fabricated.`;

  // Truncate document if exceedingly large to stay comfortably within context
  const maxChars = 80000;
  const contentToAnalyze =
    rawDocumentText.length > maxChars
      ? `${rawDocumentText.slice(0, maxChars)}\n\n[Document truncated for length]`
      : rawDocumentText;

  let rawJsonResponse = '';
  let lastError: unknown = null;

  if (config.openaiApiKey) {
    try {
      rawJsonResponse = await callOpenAiCompatible([
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `SOURCE DOCUMENT TEXT TO EXTRACT:\n"""\n${contentToAnalyze}\n"""`,
        },
      ]);
    } catch (err: unknown) {
      lastError = err;
      logger.warn(
        `OpenAI/OpenRouter call failed: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }
  }

  if (!rawJsonResponse) {
    throw new ApiError(
      `AI extraction service unavailable: ${lastError instanceof Error ? lastError.message : 'No response from model'}`,
      503,
      true,
      '',
      { code: 'AI_EXTRACTION_UNAVAILABLE' },
    );
  }

  let parsed: ExtractedAiResponse;
  try {
    const cleanJson = rawJsonResponse
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    parsed = JSON.parse(cleanJson);
  } catch (err) {
    logger.error({ rawJsonResponse, err }, 'Failed to parse AI JSON response');
    throw new ApiError(
      'AI generated an invalid JSON response.',
      502,
      true,
      '',
      {
        code: 'AI_INVALID_RESPONSE',
      },
    );
  }

  // Reject non-procedure / gibberish / source code content
  if (
    parsed.isValidProcedure === false ||
    parsed.titleEn?.toLowerCase() === 'no procedure specified' ||
    parsed.titleEn?.toLowerCase() === 'invalid document' ||
    parsed.purposeEn
      ?.toLowerCase()
      .includes('no purpose or guidelines provided')
  ) {
    throw new ApiError(
      parsed.rejectionReason ||
        'The uploaded document does not contain valid operational procedure or recipe content.',
      422,
      true,
      '',
      { code: 'INVALID_PROCEDURE_CONTENT' },
    );
  }

  const titleEn = (parsed.titleEn || parsed.titleEs || 'Imported Procedure')
    .trim()
    .slice(0, 200);
  const titleEs = (
    parsed.titleEs ||
    parsed.titleEn ||
    'Procedimiento Importado'
  )
    .trim()
    .slice(0, 200);
  const purposeEn = (
    parsed.purposeEn ||
    parsed.purposeEs ||
    'Procedure imported from document.'
  ).trim();
  const purposeEs = (
    parsed.purposeEs ||
    parsed.purposeEn ||
    'Procedimiento importado desde documento.'
  ).trim();

  const { bodyEn, bodyEs } = normalizeProcedureBlocks(parsed.blocks);

  return {
    titleEn,
    titleEs,
    purposeEn,
    purposeEs,
    bodyEn,
    bodyEs,
  };
}
