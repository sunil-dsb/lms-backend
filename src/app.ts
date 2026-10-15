import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { sql } from './db/client.ts';
import { logger } from './config/logger.ts';
import router from './routes.ts';
import { auth } from './config/auth.ts';
import { requestId } from './middleware/request-id.ts';
import { notFoundHandler } from './middleware/not-found.ts';
import { errorConverter, errorHandler } from './middleware/error-handler.ts';
import config from './config/env.ts';

const app: Express = express();

// -------------------------
//  Request Logging
// -------------------------
app.use(requestId);
function formatTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

app.use((req: Request, res: Response, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const url = req.originalUrl ?? req.url;
    const code = res.statusCode;
    const level = code >= 500 ? 'ERROR' : code >= 400 ? 'WARN ' : 'INFO ';
    const line =
      `${formatTimestamp(new Date())} ${level} ` +
      `${req.method} ${url} -> ${code} (${ms}ms)`;
    console.log(line);
  });
  next();
});

// -------------------------
//  Security & General Middleware
// -------------------------
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. curl, server-to-server, mobile)
      if (!origin) return callback(null, true);

      const allowedList = config.cors || [];
      const isAllowedExplicit = allowedList.includes(origin);
      const isLocalOrTunnel =
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
        /\.devtunnels\.ms$/.test(origin);

      if (
        isAllowedExplicit ||
        isLocalOrTunnel ||
        config.env === 'development'
      ) {
        return callback(null, true);
      }
      return callback(new Error(`CORS not allowed for origin: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'QUERY', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'X-Requested-With',
      'x-request-id',
      'x-requested-with',
    ],
    exposedHeaders: ['X-Request-Id'],
  }),
);

app.use(helmet());
app.set('trust proxy', 1);

// -------------------------
//  Better Auth
// -------------------------
// Better Auth's built-in endpoints must be registered BEFORE express.json()
// because it consumes the raw request stream.
app.all('/api/auth/{*splat}', toNodeHandler(auth));

// Procedures carry two rich bilingual block bodies; real ones go well past
// the 100kb default, so allow up to 2mb.
app.use(express.json({ limit: '2mb' }));

// -------------------------
//  Routes
// -------------------------
const healthCheck = (_req: Request, res: Response) => {
  res.json({
    ok: true,
    success: { message: 'Backend is running successfully!' },
  });
};

app.get('/', healthCheck);
app.get('/health', healthCheck);

app.get('/health/db', async (_req: Request, res: Response) => {
  try {
    const rows = await sql<{ ok: number }[]>`select 1 as ok`;
    res.json({ ok: true, db: rows[0]?.ok === 1 });
  } catch (err) {
    logger.error({ err }, 'db connection failed');
    res.status(503).json({
      ok: false,
      error: { code: 'DB_UNREACHABLE', message: 'Database connection failed' },
    });
  }
});

app.use('/api/v1', router);

// -------------------------
//  Error Handling
// -------------------------
app.use(notFoundHandler);
app.use(errorConverter);
app.use(errorHandler);

export default app;
