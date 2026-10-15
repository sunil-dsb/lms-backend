import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import ApiError from '../../shared/utils/ApiError.ts';

const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.csv', '.txt'];

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/csv',
  'text/plain',
  'application/octet-stream',
]);

/**
 * Extracts raw textual content from an uploaded document buffer.
 * Supports PDF, DOCX, CSV, TXT, and Markdown.
 */
export async function extractDocumentText(
  file: Express.Multer.File,
): Promise<string> {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new ApiError('No file uploaded or file is empty', 400, true, '', {
      code: 'INVALID_FILE',
    });
  }

  const originalName = (file.originalname || '').toLowerCase();
  const mimeType = (file.mimetype || '').toLowerCase();

  const isPdf = originalName.endsWith('.pdf') || mimeType === 'application/pdf';
  const isDocx =
    originalName.endsWith('.docx') ||
    mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const isCsv = originalName.endsWith('.csv') || mimeType === 'text/csv';
  const isText =
    originalName.endsWith('.txt') ||
    originalName.endsWith('.md') ||
    mimeType === 'text/plain' ||
    mimeType === 'text/markdown';

  let extractedText: string;

  try {
    if (isPdf) {
      const pdfData = await pdfParse(file.buffer);
      extractedText = pdfData.text || '';
    } else if (isDocx) {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      extractedText = result.value || '';
    } else if (isCsv || isText) {
      extractedText = file.buffer.toString('utf-8');
    } else {
      // Fallback check extension
      const hasSupportedExtension = SUPPORTED_EXTENSIONS.some((ext) =>
        originalName.endsWith(ext),
      );
      if (!hasSupportedExtension && !SUPPORTED_MIME_TYPES.has(mimeType)) {
        throw new ApiError(
          `Unsupported file format: ${originalName || mimeType}. Supported formats: PDF, DOCX, CSV, TXT, MD.`,
          400,
          true,
          '',
          { code: 'UNSUPPORTED_FILE_TYPE' },
        );
      }
      extractedText = file.buffer.toString('utf-8');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      `Failed to extract text from file: ${error instanceof Error ? error.message : 'Unknown parsing error'}`,
      422,
      true,
      '',
      { code: 'DOCUMENT_EXTRACTION_FAILED' },
    );
  }

  const trimmed = extractedText.trim();
  if (!trimmed) {
    throw new ApiError(
      'The uploaded document contains no readable text.',
      422,
      true,
      '',
      {
        code: 'DOCUMENT_EMPTY',
      },
    );
  }

  return trimmed;
}
