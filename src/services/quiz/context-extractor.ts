import type {
  ProcedureContextInput,
  ChapterContextInput,
} from './quiz-ai.types.ts';
import { logger } from '../../config/logger.ts';
import config from '../../config/index.ts';
import { db } from '../../db/client.ts';
import { procedures } from '../../db/schema/procedures.schema.ts';
import { inArray } from 'drizzle-orm';

/**
 * Extracts plain text from a PDF file located at an HTTP/HTTPS URL, R2 bucket key, or local path.
 */
export async function extractPdfText(src: string): Promise<string> {
  try {
    let buffer: Buffer;
    let url = src;

    // Resolve relative or bucket keys like /uploads/... to public URL if configured
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      if (
        config.r2PublicBaseUrl &&
        (url.startsWith('/uploads/') || url.startsWith('uploads/'))
      ) {
        const cleanKey = url.replace(/^\/+/, '');
        url = `${config.r2PublicBaseUrl.replace(/\/+$/, '')}/${cleanKey}`;
      }
    }

    if (url.startsWith('http://') || url.startsWith('https://')) {
      const res = await fetch(url);
      if (!res.ok) return '';
      const arrayBuffer = await res.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } else {
      const fs = await import('node:fs/promises');
      buffer = await fs.readFile(url);
    }
    const pdf = (await import('pdf-parse')).default;
    const parsed = await pdf(buffer);
    return parsed.text || '';
  } catch (err) {
    logger.warn({ err, src }, 'Failed to parse PDF text');
    return '';
  }
}

/**
 * Helper to extract bilingual strings from various schema shapes.
 */
export function extractBilingualStr(val: unknown): string {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const en = typeof obj.en === 'string' ? obj.en.trim() : '';
    const es = typeof obj.es === 'string' ? obj.es.trim() : '';
    return en || es;
  }
  return '';
}

/**
 * Helper to extract plain text and any ordered steps from TipTap/ProseMirror JSON docs.
 */
export function extractTextFromTipTapNode(node: unknown): {
  text: string;
  orderedSteps: string[];
} {
  if (!node || typeof node !== 'object') return { text: '', orderedSteps: [] };
  const n = node as Record<string, unknown>;
  const type = n.type;
  const orderedSteps: string[] = [];

  if (type === 'text' && typeof n.text === 'string') {
    return { text: n.text, orderedSteps: [] };
  }

  if (type === 'hardBreak') {
    return { text: '\n', orderedSteps: [] };
  }

  if (Array.isArray(n.content)) {
    const childTexts: string[] = [];

    for (const child of n.content) {
      const { text, orderedSteps: childSteps } =
        extractTextFromTipTapNode(child);
      if (text) childTexts.push(text);
      if (childSteps.length > 0) orderedSteps.push(...childSteps);
    }

    if (type === 'orderedList') {
      const listItems: string[] = [];
      n.content.forEach((li, idx) => {
        const { text: liText } = extractTextFromTipTapNode(li);
        const clean = liText.trim();
        if (clean) {
          listItems.push(`${idx + 1}. ${clean}`);
          orderedSteps.push(clean);
        }
      });
      return { text: listItems.join('\n') + '\n', orderedSteps };
    }

    if (type === 'bulletList') {
      const listItems = childTexts.map((item) => `- ${item.trim()}`).join('\n');
      return { text: listItems + '\n', orderedSteps };
    }

    if (type === 'paragraph' || type === 'heading') {
      const pText = childTexts.join('');
      const stepMatch = pText.match(/^Step\s+(\d+)[:.]\s*(.+)/i);
      if (stepMatch) {
        orderedSteps.push(pText.trim());
      }
      return { text: pText + '\n', orderedSteps };
    }

    if (type === 'listItem') {
      return { text: childTexts.join(' ').trim(), orderedSteps };
    }

    return { text: childTexts.join(' '), orderedSteps };
  }

  return { text: '', orderedSteps: [] };
}

/**
 * Extracts high-density procedural context and counts available chronological steps across all block kinds.
 */
export async function extractProcedureContext(
  procedure: ProcedureContextInput,
  visitedProcedureIds: Set<string> = new Set(),
): Promise<{
  contextText: string;
  methodStepsCount: number;
  hasAttachmentText: boolean;
}> {
  const lines: string[] = [];
  let methodStepsCount = 0;

  const titleEn = procedure.titleEn?.trim();
  const titleEs = procedure.titleEs?.trim();
  if (titleEn || titleEs) {
    lines.push(
      `PROCEDURE TITLE: ${titleEn || titleEs} (${titleEs || titleEn})`,
    );
  }

  const purposeEn = procedure.purposeEn?.trim();
  const purposeEs = procedure.purposeEs?.trim();
  if (purposeEn || purposeEs) {
    lines.push(`PURPOSE: ${purposeEn || purposeEs}`);
  }

  // Standalone or block-level ingredients
  const allIngredients: Array<{
    name: string;
    amount?: string | undefined;
    unit?: string | undefined;
    allergen?: boolean | undefined;
  }> = [];
  if (Array.isArray(procedure.ingredients)) {
    for (const item of procedure.ingredients) {
      if (
        item &&
        typeof item === 'object' &&
        'name' in item &&
        typeof item.name === 'string'
      ) {
        let amountStr: string | undefined =
          typeof item.amount === 'string' ? item.amount : undefined;
        if (
          !amountStr &&
          'amounts' in item &&
          Array.isArray(item.amounts) &&
          item.amounts.length > 0
        ) {
          amountStr =
            typeof item.amounts[0] === 'string'
              ? item.amounts[0]
              : String(item.amounts[0]);
        }
        allIngredients.push({
          name: item.name,
          amount: amountStr,
          unit: typeof item.unit === 'string' ? item.unit : undefined,
          allergen: Boolean(item.allergen),
        });
      }
    }
  }

  // Walk procedure blocks
  const blocks = procedure.blocks || [];
  const methodStepsList: string[] = [];
  const warningsList: string[] = [];
  const checklistList: string[] = [];
  const textNotes: string[] = [];
  const attachmentTexts: string[] = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const kind = block.kind;

    if (kind === 'ingredients' && Array.isArray(block.ingredients)) {
      for (const ing of block.ingredients) {
        if (
          ing &&
          typeof ing === 'object' &&
          'name' in ing &&
          typeof ing.name === 'string'
        ) {
          let amountStr: string | undefined =
            typeof ing.amount === 'string' ? ing.amount : undefined;
          if (
            !amountStr &&
            Array.isArray(ing.amounts) &&
            ing.amounts.length > 0
          ) {
            amountStr =
              typeof ing.amounts[0] === 'string'
                ? ing.amounts[0]
                : String(ing.amounts[0]);
          }
          allIngredients.push({
            name: ing.name,
            amount: amountStr,
            unit: typeof ing.unit === 'string' ? ing.unit : undefined,
            allergen: Boolean(ing.allergen),
          });
        }
      }
      if (block.allergen && typeof block.allergen === 'object') {
        const a = block.allergen as Record<string, unknown>;
        if (
          Array.isArray(a.selectedAllergens) &&
          a.selectedAllergens.length > 0
        ) {
          warningsList.push(`Allergens: ${a.selectedAllergens.join(', ')}`);
        }
        if (typeof a.summary === 'string' && a.summary.trim()) {
          warningsList.push(`Allergen Summary: ${a.summary.trim()}`);
        }
        if (typeof a.detail === 'string' && a.detail.trim()) {
          warningsList.push(`Allergen Details: ${a.detail.trim()}`);
        }
        const names = Object.keys(a).filter((k) => a[k] === true);
        if (names.length > 0) {
          warningsList.push(`Allergen Flags: ${names.join(', ')}`);
        }
      }
    } else if (kind === 'method' && Array.isArray(block.steps)) {
      if (block.title) {
        const mTitle = extractBilingualStr(block.title);
        if (mTitle) methodStepsList.push(`\n[Section: ${mTitle}]`);
      }
      for (const step of block.steps) {
        if (!step || typeof step !== 'object') continue;
        let stepText = '';
        if (step.body && typeof step.body === 'object') {
          const body = step.body as { en?: string; es?: string };
          stepText = body.en?.trim() || body.es?.trim() || '';
        } else if (typeof step.body === 'string') {
          stepText = step.body.trim();
        }
        if (stepText) {
          methodStepsCount++;
          let fullStep = `Step ${methodStepsCount}: ${stepText}`;
          if (step.timer && typeof step.timer === 'object') {
            const t = step.timer as Record<string, unknown>;
            if (t.seconds) {
              const mins = Math.floor(Number(t.seconds) / 60);
              const secs = Number(t.seconds) % 60;
              const dur =
                mins > 0
                  ? `${mins} min${secs > 0 ? ` ${secs} sec` : ''}`
                  : `${secs} sec`;
              fullStep += ` (Timer: ${t.label || 'Duration'} - ${dur})`;
            }
          }
          methodStepsList.push(fullStep);
        }
        if (step.criticalLimit && typeof step.criticalLimit === 'object') {
          const cl = step.criticalLimit as Record<string, unknown>;
          const parts = [
            cl.label ? `[${cl.label}]` : '[CRITICAL CONTROL POINT]',
            cl.value ? `Target: ${cl.value}` : '',
            cl.howToCheck ? `Verification: ${cl.howToCheck}` : '',
            cl.breachResponse ? `Corrective Action: ${cl.breachResponse}` : '',
          ].filter(Boolean);
          if (parts.length > 0) {
            warningsList.push(parts.join(' - '));
          }
        }
        if (step.discardAt && step.discardAtHours) {
          warningsList.push(
            `Maximum holding time: ${step.discardAtHours} hours before discarding.`,
          );
        }
        if (step.note && typeof step.note === 'object') {
          const n = step.note as Record<string, unknown>;
          const sev =
            typeof n.severity === 'string'
              ? `[${n.severity.toUpperCase()}] `
              : '';
          const nText = extractBilingualStr(n.body);
          if (nText) warningsList.push(`${sev}${nText}`);
        }
      }
    } else if (
      (kind === 'warning' || kind === 'callout' || kind === 'note') &&
      block.body
    ) {
      const sev =
        typeof block.severity === 'string'
          ? `[${block.severity.toUpperCase()}] `
          : '';
      const wText = extractBilingualStr(block.body);
      if (wText) {
        warningsList.push(`${sev}${wText}`);
      }
    } else if (kind === 'checklist' && Array.isArray(block.items)) {
      const cTitle = extractBilingualStr(block.title);
      if (cTitle) checklistList.push(`Checklist - ${cTitle}:`);
      for (const item of block.items) {
        if (!item || typeof item !== 'object') continue;
        const itemObj = item as { text?: unknown };
        const cText = extractBilingualStr(itemObj.text);
        if (cText) {
          checklistList.push(`- [ ] ${cText}`);
        }
      }
    } else if (kind === 'text' && block.body) {
      const tText = extractBilingualStr(block.body);
      if (tText) {
        textNotes.push(tText);
      }
    } else if (
      kind === 'rich_text' &&
      block.body &&
      typeof block.body === 'object'
    ) {
      const body = block.body as Record<string, unknown>;
      const { text: textEn, orderedSteps: stepsEn } = extractTextFromTipTapNode(
        body.en,
      );
      const { text: textEs, orderedSteps: stepsEs } = extractTextFromTipTapNode(
        body.es,
      );
      const combined = textEn.trim() || textEs.trim();
      if (combined) {
        textNotes.push(combined);
      }
      const steps = stepsEn.length > 0 ? stepsEn : stepsEs;
      for (const st of steps) {
        methodStepsCount++;
        methodStepsList.push(`Step ${methodStepsCount}: ${st}`);
      }
    } else if (kind === 'heading' && block.text) {
      const hText = extractBilingualStr(block.text);
      if (hText) textNotes.push(`\n## ${hText}`);
    } else if (kind === 'table') {
      const headers = Array.isArray(block.headers)
        ? block.headers.map((h: unknown) => extractBilingualStr(h))
        : [];
      const rows = Array.isArray(block.rows)
        ? block.rows.map((row: unknown) =>
            Array.isArray(row)
              ? row.map((cell: unknown) => extractBilingualStr(cell))
              : [],
          )
        : [];
      if (headers.length > 0 || rows.length > 0) {
        const tableLines: string[] = ['\nTABLE DATA:'];
        if (headers.length > 0) {
          tableLines.push(`| ${headers.join(' | ')} |`);
          tableLines.push(`| ${headers.map(() => '---').join(' | ')} |`);
        }
        for (const row of rows) {
          tableLines.push(`| ${row.join(' | ')} |`);
        }
        textNotes.push(tableLines.join('\n'));
      }
    } else if (kind === 'image') {
      const alt = extractBilingualStr(block.alt);
      const caption = extractBilingualStr(block.caption);
      const imgDesc = [alt, caption].filter(Boolean).join(' - ');
      if (imgDesc) {
        textNotes.push(`IMAGE: ${imgDesc}`);
      }
    } else if (kind === 'video') {
      const caption = extractBilingualStr(block.caption);
      if (caption) {
        textNotes.push(`VIDEO: ${caption}`);
      }
    } else if (kind === 'attachment') {
      const title = extractBilingualStr(block.title);
      const meta = typeof block.meta === 'string' ? block.meta.trim() : '';
      const href = typeof block.href === 'string' ? block.href.trim() : '';
      const attInfo = [title, meta, href].filter(Boolean).join(' | ');
      if (attInfo) {
        textNotes.push(`ATTACHMENT: ${attInfo}`);
      }
      // If href is a URL/path to a PDF, extract its text content
      if (
        href &&
        (href.toLowerCase().endsWith('.pdf') ||
          (meta && meta.toLowerCase().includes('pdf')))
      ) {
        try {
          const pdfText = await extractPdfText(href);
          if (pdfText && pdfText.trim()) {
            const trimmedPdf = pdfText.trim().slice(0, 8000);
            attachmentTexts.push(
              `\n[ATTACHED DOCUMENT (${title || 'PDF'}) CONTENT]:\n${trimmedPdf}`,
            );
          }
        } catch {
          // Non-blocking fallback
        }
      }
    } else if (
      kind === 'linked_procedures' &&
      Array.isArray(block.procedureIds)
    ) {
      const unvisited = block.procedureIds.filter(
        (id: unknown): id is string =>
          typeof id === 'string' &&
          id.trim().length > 0 &&
          !visitedProcedureIds.has(id.trim()),
      );
      if (unvisited.length > 0) {
        for (const uid of unvisited) visitedProcedureIds.add(uid);
        try {
          const linkedRows = await db
            .select()
            .from(procedures)
            .where(inArray(procedures.id, unvisited));
          for (const lRow of linkedRows) {
            let lBlocks: Array<Record<string, unknown>> = [];
            const rawB = lRow.blocksEn;
            if (Array.isArray(rawB)) {
              lBlocks = rawB as Array<Record<string, unknown>>;
            } else if (
              rawB &&
              typeof rawB === 'object' &&
              'blocks' in rawB &&
              Array.isArray((rawB as { blocks: unknown[] }).blocks)
            ) {
              lBlocks = (rawB as { blocks: Array<Record<string, unknown>> })
                .blocks;
            }
            const lCtx = await extractProcedureContext(
              {
                titleEn: lRow.titleEn,
                titleEs: lRow.titleEs,
                purposeEn: lRow.purposeEn,
                purposeEs: lRow.purposeEs,
                blocks: lBlocks,
              },
              visitedProcedureIds,
            );
            if (lCtx.contextText) {
              textNotes.push(
                `\n[LINKED SUB-PROCEDURE: ${lRow.titleEn} (${lRow.titleEs})]:\n${lCtx.contextText}`,
              );
              methodStepsCount += lCtx.methodStepsCount;
            }
          }
        } catch (err) {
          logger.warn(
            { err, unvisited },
            'Failed to load sub-procedure blocks',
          );
        }
      }
    }
  }

  if (allIngredients.length > 0) {
    lines.push('\nINGREDIENTS:');
    for (const ing of allIngredients) {
      const qty = [ing.amount, ing.unit].filter(Boolean).join(' ');
      const allergenNotice = ing.allergen ? ' (ALLERGEN)' : '';
      lines.push(`- ${ing.name}${qty ? `: ${qty}` : ''}${allergenNotice}`);
    }
  }

  if (methodStepsList.length > 0) {
    lines.push('\nCHRONOLOGICAL METHOD STEPS:');
    lines.push(...methodStepsList);
  }

  if (warningsList.length > 0) {
    lines.push('\nFOOD SAFETY, WARNINGS & CRITICAL POINTS:');
    lines.push(...warningsList.map((w) => `- ${w}`));
  }

  if (checklistList.length > 0) {
    lines.push('\nCHECKLIST & VERIFICATIONS:');
    lines.push(...checklistList.map((c) => `- ${c}`));
  }

  if (textNotes.length > 0) {
    lines.push('\nADDITIONAL OPERATIONAL NOTES:');
    lines.push(...textNotes.map((t) => `- ${t}`));
  }

  if (attachmentTexts.length > 0) {
    lines.push('\nDOCUMENT ATTACHMENT CONTENT:');
    lines.push(...attachmentTexts);
  }

  return {
    contextText: lines.join('\n').trim(),
    methodStepsCount,
    hasAttachmentText: attachmentTexts.length > 0,
  };
}

/**
 * Extracts comprehensive context from a course chapter, including rich text,
 * media captions, attachments (with PDF text parsing), and structured blocks.
 */
export async function extractChapterContext(
  chapter: ChapterContextInput,
): Promise<{
  contextText: string;
  methodStepsCount: number;
  hasAttachmentText: boolean;
}> {
  const lines: string[] = [];
  let methodStepsCount = 0;

  if (chapter.courseName) {
    lines.push(`COURSE: ${chapter.courseName.trim()}`);
  }

  const chNum = chapter.chapterNumber
    ? `Chapter ${chapter.chapterNumber}: `
    : '';
  const titleEn = chapter.titleEn?.trim();
  const titleEs = chapter.titleEs?.trim();
  if (titleEn || titleEs) {
    lines.push(
      `CHAPTER TITLE: ${chNum}${titleEn || titleEs} (${titleEs || titleEn})`,
    );
  }

  const purposeEn = chapter.purposeEn?.trim();
  const purposeEs = chapter.purposeEs?.trim();
  if (purposeEn || purposeEs) {
    lines.push(`CHAPTER PURPOSE / OVERVIEW: ${purposeEn || purposeEs}`);
  }

  const blocks = chapter.blocks || [];
  const methodStepsList: string[] = [];
  const warningsList: string[] = [];
  const checklistList: string[] = [];
  const textNotes: string[] = [];
  const attachmentTexts: string[] = [];
  let attachedProcHasAttachments = false;

  // 1. Collect all linked procedure IDs from chapter fields and blocks
  const procedureIdsToFetch: string[] = [];
  if (typeof chapter.procedureId === 'string' && chapter.procedureId.trim()) {
    procedureIdsToFetch.push(chapter.procedureId.trim());
  }
  if (Array.isArray(chapter.procedureIds)) {
    for (const pid of chapter.procedureIds) {
      if (typeof pid === 'string' && pid.trim()) {
        procedureIdsToFetch.push(pid.trim());
      }
    }
  }
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (Array.isArray(block.procedureIds)) {
      for (const pid of block.procedureIds) {
        if (typeof pid === 'string' && pid.trim()) {
          procedureIdsToFetch.push(pid.trim());
        }
      }
    }
    if (typeof block.procedureId === 'string' && block.procedureId.trim()) {
      procedureIdsToFetch.push(block.procedureId.trim());
    }
  }

  // 2. Fetch and resolve all attached procedures from DB
  const uniqueProcedureIds = Array.from(new Set(procedureIdsToFetch));
  logger.info(
    {
      chapterBlocksCount: blocks.length,
      procedureIdsToFetch: uniqueProcedureIds,
    },
    'extractChapterContext: Resolving linked procedures for chapter quiz',
  );

  if (uniqueProcedureIds.length > 0) {
    try {
      const procRows = await db
        .select()
        .from(procedures)
        .where(inArray(procedures.id, uniqueProcedureIds));

      logger.info(
        {
          requested: uniqueProcedureIds,
          found: procRows.length,
          titles: procRows.map((p) => p.titleEn),
        },
        'extractChapterContext: Fetched procedure rows from database',
      );

      for (const procRow of procRows) {
        let procBlocks: Array<Record<string, unknown>> = [];
        const rawBlocks = procRow.blocksEn;
        if (Array.isArray(rawBlocks)) {
          procBlocks = rawBlocks as Array<Record<string, unknown>>;
        } else if (
          rawBlocks &&
          typeof rawBlocks === 'object' &&
          'blocks' in rawBlocks &&
          Array.isArray((rawBlocks as { blocks: unknown[] }).blocks)
        ) {
          procBlocks = (
            rawBlocks as {
              blocks: Array<Record<string, unknown>>;
            }
          ).blocks;
        }

        const procCtx = await extractProcedureContext(
          {
            titleEn: procRow.titleEn,
            titleEs: procRow.titleEs,
            purposeEn: procRow.purposeEn,
            purposeEs: procRow.purposeEs,
            blocks: procBlocks,
          },
          new Set([procRow.id]),
        );

        if (procCtx.contextText) {
          lines.push(
            `\n=== ATTACHED PROCEDURE / RECIPE: ${procRow.titleEn} (${procRow.titleEs}) ===`,
          );
          lines.push(procCtx.contextText);
          methodStepsCount += procCtx.methodStepsCount;
          if (procCtx.hasAttachmentText) {
            attachedProcHasAttachments = true;
          }
        }
      }
    } catch (err) {
      logger.warn(
        { err, uniqueProcedureIds },
        'Failed to fetch attached procedures for chapter context',
      );
    }
  }

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const kind = block.kind;

    if (kind === 'rich_text' && block.body && typeof block.body === 'object') {
      const body = block.body as Record<string, unknown>;
      const { text: textEn, orderedSteps: stepsEn } = extractTextFromTipTapNode(
        body.en,
      );
      const { text: textEs, orderedSteps: stepsEs } = extractTextFromTipTapNode(
        body.es,
      );
      const combined = textEn.trim() || textEs.trim();
      if (combined) {
        textNotes.push(combined);
      }
      const steps = stepsEn.length > 0 ? stepsEn : stepsEs;
      for (const st of steps) {
        methodStepsCount++;
        methodStepsList.push(`Step ${methodStepsCount}: ${st}`);
      }
    } else if (kind === 'method' && Array.isArray(block.steps)) {
      if (block.title) {
        const mTitle = extractBilingualStr(block.title);
        if (mTitle) methodStepsList.push(`\n[Section: ${mTitle}]`);
      }
      for (const step of block.steps) {
        if (!step || typeof step !== 'object') continue;
        let stepText = '';
        if (step.body && typeof step.body === 'object') {
          const body = step.body as { en?: string; es?: string };
          stepText = body.en?.trim() || body.es?.trim() || '';
        } else if (typeof step.body === 'string') {
          stepText = step.body.trim();
        }
        if (stepText) {
          methodStepsCount++;
          methodStepsList.push(`Step ${methodStepsCount}: ${stepText}`);
        }
      }
    } else if (kind === 'heading' && block.text) {
      const hText = extractBilingualStr(block.text);
      if (hText) textNotes.push(`\n## ${hText}`);
    } else if (kind === 'text' && block.body) {
      const tText = extractBilingualStr(block.body);
      if (tText) textNotes.push(tText);
    } else if (
      (kind === 'warning' || kind === 'callout' || kind === 'note') &&
      block.body
    ) {
      const sev =
        typeof block.severity === 'string'
          ? `[${block.severity.toUpperCase()}] `
          : '';
      const wText = extractBilingualStr(block.body);
      if (wText) warningsList.push(`${sev}${wText}`);
    } else if (kind === 'checklist' && Array.isArray(block.items)) {
      const cTitle = extractBilingualStr(block.title);
      if (cTitle) checklistList.push(`Checklist - ${cTitle}:`);
      for (const item of block.items) {
        if (!item || typeof item !== 'object') continue;
        const itemObj = item as { text?: unknown };
        const cText = extractBilingualStr(itemObj.text);
        if (cText) checklistList.push(`- [ ] ${cText}`);
      }
    } else if (kind === 'table') {
      const headers = Array.isArray(block.headers)
        ? block.headers.map((h: unknown) => extractBilingualStr(h))
        : [];
      const rows = Array.isArray(block.rows)
        ? block.rows.map((row: unknown) =>
            Array.isArray(row)
              ? row.map((cell: unknown) => extractBilingualStr(cell))
              : [],
          )
        : [];
      if (headers.length > 0 || rows.length > 0) {
        const tableLines: string[] = ['\nTABLE DATA:'];
        if (headers.length > 0) {
          tableLines.push(`| ${headers.join(' | ')} |`);
          tableLines.push(`| ${headers.map(() => '---').join(' | ')} |`);
        }
        for (const row of rows) {
          tableLines.push(`| ${row.join(' | ')} |`);
        }
        textNotes.push(tableLines.join('\n'));
      }
    } else if (kind === 'image') {
      const alt = extractBilingualStr(block.alt);
      const caption = extractBilingualStr(block.caption);
      const imgDesc = [alt, caption].filter(Boolean).join(' - ');
      if (imgDesc) {
        textNotes.push(`IMAGE / DIAGRAM: ${imgDesc}`);
      }
    } else if (kind === 'video') {
      const caption = extractBilingualStr(block.caption);
      if (caption) {
        textNotes.push(`VIDEO REFERENCE: ${caption}`);
      }
    } else if (kind === 'attachment') {
      const title = extractBilingualStr(block.title);
      const meta = typeof block.meta === 'string' ? block.meta.trim() : '';
      const href = typeof block.href === 'string' ? block.href.trim() : '';
      const attInfo = [title, meta, href].filter(Boolean).join(' | ');
      if (attInfo) {
        textNotes.push(`ATTACHMENT: ${attInfo}`);
      }
      // If href is a URL to a PDF, attempt to extract text
      if (
        href &&
        (href.toLowerCase().endsWith('.pdf') ||
          (meta && meta.toLowerCase().includes('pdf')))
      ) {
        try {
          const pdfText = await extractPdfText(href);
          if (pdfText && pdfText.trim()) {
            const trimmedPdf = pdfText.trim().slice(0, 8000);
            attachmentTexts.push(
              `\n[ATTACHED DOCUMENT (${title || 'PDF'}) CONTENT]:\n${trimmedPdf}`,
            );
          }
        } catch {
          // Non-blocking: continue if PDF parsing fails
        }
      }
    } else if (
      kind === 'linked_procedures' &&
      Array.isArray(block.procedureIds)
    ) {
      if (block.procedureIds.length > 0) {
        textNotes.push(
          `LINKED PROCEDURES (IDs): ${block.procedureIds.join(', ')}`,
        );
      }
    }
  }

  if (methodStepsList.length > 0) {
    lines.push('\nCHRONOLOGICAL LESSON / PROCEDURE STEPS:');
    lines.push(...methodStepsList);
  }

  if (warningsList.length > 0) {
    lines.push('\nKEY GUIDELINES, CAUTIONS & CRITICAL POINTS:');
    lines.push(...warningsList.map((w) => `- ${w}`));
  }

  if (checklistList.length > 0) {
    lines.push('\nCHECKLISTS & PRACTICAL TASKS:');
    lines.push(...checklistList.map((c) => `- ${c}`));
  }

  if (textNotes.length > 0) {
    lines.push('\nCHAPTER LESSON CONTENT:');
    lines.push(...textNotes.map((t) => `- ${t}`));
  }

  if (attachmentTexts.length > 0) {
    lines.push('\nATTACHED DOCUMENTS CONTENT:');
    lines.push(...attachmentTexts);
  }

  return {
    contextText: lines.join('\n').trim(),
    methodStepsCount,
    hasAttachmentText: attachmentTexts.length > 0 || attachedProcHasAttachments,
  };
}
