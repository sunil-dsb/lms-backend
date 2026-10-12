import { S3Client } from '@aws-sdk/client-s3';
import { logger } from '../../config/logger.ts';

import config from '../../config/index.ts';

let warnedMissingEnv = false;

function warnMissingEnvOnce(): void {
  if (warnedMissingEnv) return;
  warnedMissingEnv = true;
  logger.warn(
    'r2 client not configured - R2_* env vars missing, uploads will fail',
  );
}

// Lazy so dev boots without R2 configured; the warn fires on first use.
let s3Instance: S3Client | null = null;

export function getS3Client(): S3Client {
  if (s3Instance) return s3Instance;
  const accountId = config.r2AccountId || process.env.R2_ACCOUNT_ID;
  const accessKeyId = config.r2AccessKeyId || process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey =
    config.r2SecretAccessKey || process.env.R2_SECRET_ACCESS_KEY;
  const endpoint =
    config.r2Endpoint ||
    process.env.R2_ENDPOINT ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    warnMissingEnvOnce();
    // Throw so callers can map to a 500; the warn above tells the operator.
    throw new Error('R2 client not configured (R2_* env vars missing)');
  }
  s3Instance = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
  return s3Instance;
}

export const s3 = new Proxy({} as S3Client, {
  get(_target, prop) {
    const client = getS3Client();
    const val = (client as unknown as Record<string | symbol, unknown>)[prop];
    return typeof val === 'function' ? val.bind(client) : val;
  },
});

// <folder>/<yyyy>/<mm>/<uuid>.<ext> — month-sharded for cheap future
// per-month lifecycle policies; uuid leaf to avoid collisions.
// `folder` is one of the allow-listed prefixes the upload service passes
// (e.g. 'images', 'videos', 'documents'); kept short so the key stays
// under S3's 1024-byte limit even with a deep prefix.
export type UploadFolder = 'images' | 'videos' | 'documents';

export function buildKey(
  folder: UploadFolder,
  _contentType: string,
  originalName: string,
): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const ext = pickExtension(originalName);
  const uuid = crypto.randomUUID();
  return `${folder}/${yyyy}/${mm}/${uuid}${ext}`;
}

function pickExtension(originalName: string): string {
  const dot = originalName.lastIndexOf('.');
  if (dot === -1 || dot === originalName.length - 1) return '';
  const raw = originalName.slice(dot + 1).toLowerCase();
  // Only allow the same extensions the controller whitelists; fall back
  // to empty so the caller enforces the mime allowlist.
  if (/^[a-z0-9]{1,5}$/.test(raw)) return `.${raw}`;
  return '';
}

export function publicUrlFor(key: string): string {
  const base = process.env.R2_PUBLIC_BASE_URL ?? '';
  return `${base.replace(/\/$/, '')}/${key}`;
}
