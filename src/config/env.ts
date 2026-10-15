import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: 'development.env' });

const envVarsSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.preprocess(
    (val) => (typeof val === 'string' ? parseInt(val, 10) : val),
    z.number().default(8000),
  ),
  DATABASE_URL: z.string(),
  BETTER_AUTH_SECRET: z.string(),
  BETTER_AUTH_URL: z.string().optional(),
  FRONTEND_BASE_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),

  // Cloudflare R2
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_PUBLIC_BASE_URL: z.string().optional(),
  R2_UPLOAD_TTL_SECONDS: z.preprocess(
    (val) => (typeof val === 'string' ? parseInt(val, 10) : val),
    z.number().default(600),
  ),
  R2_UPLOAD_MAX_BYTES: z.preprocess(
    (val) => (typeof val === 'string' ? parseInt(val, 10) : val),
    z.number().default(10485760),
  ),

  // AI extraction
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('openai/gpt-4o-mini'),
  OPENAI_BASE_URL: z.string().optional(),

  // Logging
  LOG_LEVEL: z.string().default('info'),
});

const response = envVarsSchema.safeParse(process.env);

if (!response.success) {
  // Name the offending variable in every issue. Without the path, a container
  // that is missing its whole environment just repeats "expected string,
  // received undefined" once per variable, which says nothing about which.
  const issues = response.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    return issue.code === 'invalid_type' && issue.input === undefined
      ? `${name} is missing`
      : `${name}: ${issue.message}`;
  });

  throw new Error(`Config validation error: ${issues.join(', ')}`);
}

const envVars = response.data;

const config = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  databaseUrl: envVars.DATABASE_URL,
  betterAuthSecret: envVars.BETTER_AUTH_SECRET,
  betterAuthUrl: envVars.BETTER_AUTH_URL,
  cors: Array.from(
    new Set(
      [
        envVars.FRONTEND_BASE_URL,
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'https://lms.dsbitteam.in',
      ].filter((o): o is string => Boolean(o)),
    ),
  ),
  frontendBaseUrl: (
    envVars.FRONTEND_BASE_URL ||
    (envVars.NODE_ENV === 'production'
      ? 'https://lms.dsbitteam.in'
      : 'http://localhost:3000')
  ).replace(/\/+$/, ''),
  resendApiKey: envVars.RESEND_API_KEY,
  r2AccountId: envVars.R2_ACCOUNT_ID,
  r2Endpoint:
    envVars.R2_ENDPOINT ||
    (envVars.R2_ACCOUNT_ID
      ? `https://${envVars.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : undefined),
  r2AccessKeyId: envVars.R2_ACCESS_KEY_ID,
  r2SecretAccessKey: envVars.R2_SECRET_ACCESS_KEY,
  r2Bucket: envVars.R2_BUCKET,
  r2PublicBaseUrl: envVars.R2_PUBLIC_BASE_URL,
  r2UploadTtlSeconds: envVars.R2_UPLOAD_TTL_SECONDS,
  r2UploadMaxBytes: envVars.R2_UPLOAD_MAX_BYTES,
  openaiApiKey: envVars.OPENAI_API_KEY,
  openaiModel: envVars.OPENAI_MODEL,
  openaiBaseUrl: envVars.OPENAI_BASE_URL,
  logLevel: envVars.LOG_LEVEL,
};

export default config;
