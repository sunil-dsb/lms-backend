import { type Request, type Response, type NextFunction } from 'express';
import ApiError from '../utils/ApiError.ts';
import httpStatus from 'http-status';
import config from '../../config/index.ts';
import * as Sentry from '@sentry/node';
import { logger } from '../../config/logger.ts';
import multer from 'multer';
import { ZodError } from 'zod';

interface ErrorLike {
  statusCode?: number;
  message?: string;
  stack?: string;
}

/** True for `postgres`-driver errors (PostgresError, connection/DNS
 *  failures). Their `message` embeds raw SQL + bound params, so they must
 *  never be forwarded to the client — the converter maps them to a safe
 *  generic message instead. */
function isPostgresDriverError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'PostgresError') return true;
  const message = (err as { message?: unknown }).message;
  return (
    typeof message === 'string' &&
    (message.startsWith('Failed query') ||
      message.includes('getaddrinfo') ||
      message.includes('ECONNREFUSED'))
  );
}

const getErrorCode = (statusCode: number): string => {
  switch (statusCode) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'TOO_MANY_REQUESTS';
    default:
      return 'INTERNAL_ERROR';
  }
};

const errorConverter = (
  err: Error | ErrorLike,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  let error: Error | ApiError =
    err instanceof Error ? err : new Error(String(err));
  Sentry.captureException(error);

  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path?.join('.') ?? 'body';
    logger.warn(`validation failed: ${where} - ${first?.message ?? 'invalid'}`);

    const details = err.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    }));

    error = new ApiError(
      'Invalid input',
      httpStatus.BAD_REQUEST,
      true,
      err.stack,
    );
    (error as ApiError).errorCode = 'VALIDATION_ERROR';
    (error as ApiError).details = details;
  } else if ((err as { type?: string }).type === 'entity.too.large') {
    logger.warn('payload too large');
    error = new ApiError(
      'Request body too large',
      httpStatus.REQUEST_ENTITY_TOO_LARGE,
      true,
      err.stack,
    );
    (error as ApiError).errorCode = 'PAYLOAD_TOO_LARGE';
  } else if ((err as { type?: string }).type === 'entity.parse.failed') {
    logger.warn('malformed json');
    error = new ApiError(
      'Request body is not valid JSON',
      httpStatus.BAD_REQUEST,
      true,
      err.stack,
    );
    (error as ApiError).errorCode = 'INVALID_JSON';
  } else if (
    typeof (err as { code?: unknown }).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((err as { code?: string }).code!)
  ) {
    const maybeCode = (err as { code?: string }).code;
    logger.error({ err }, `database error (${maybeCode})`);
    error = new ApiError(
      'A database error occurred',
      httpStatus.INTERNAL_SERVER_ERROR,
      false,
      err.stack,
    );
    (error as ApiError).errorCode = 'DATABASE_ERROR';
  } else if (isPostgresDriverError(err)) {
    // Driver errors (failed query, lost connection, DNS) carry raw SQL and
    // params in `message` — never let those reach the client. Log the full
    // error server-side, respond with a safe generic message instead.
    logger.error({ err }, 'database driver error');
    error = new ApiError(
      'A database error occurred',
      httpStatus.INTERNAL_SERVER_ERROR,
      false,
      err instanceof Error ? err.stack : undefined,
    );
    (error as ApiError).errorCode = 'DATABASE_ERROR';
  } else if (error.name === 'MulterError') {
    const multerError = error as multer.MulterError;
    if (multerError.code === 'LIMIT_UNEXPECTED_FILE') {
      error = new ApiError(
        'Cannot upload more than 5 images',
        httpStatus.BAD_REQUEST,
      );
    } else if (multerError.code === 'LIMIT_FILE_SIZE') {
      error = new ApiError(
        'File size cannot exceed 5MB',
        httpStatus.BAD_REQUEST,
      );
    } else {
      error = new ApiError(multerError.message, httpStatus.BAD_REQUEST);
    }
    (error as ApiError).errorCode = 'VALIDATION_ERROR';
  } else if (!(error instanceof ApiError)) {
    const rawError = error as ErrorLike;
    const statusCode: number =
      typeof rawError.statusCode === 'number'
        ? rawError.statusCode
        : httpStatus.INTERNAL_SERVER_ERROR;
    const message: string =
      (typeof rawError.message === 'string' ? rawError.message : '') ||
      (httpStatus as Record<number, string | undefined>)[statusCode] ||
      'Internal Server Error';
    const stack = typeof rawError.stack === 'string' ? rawError.stack : '';
    error = new ApiError(message, statusCode, false, stack);
  }
  next(error);
};

const errorHandler = (
  err: ApiError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction,
) => {
  let { statusCode, message } = err;

  if (config.env === 'production' && !err.isOperational) {
    statusCode = httpStatus.INTERNAL_SERVER_ERROR;
    message = httpStatus[httpStatus.INTERNAL_SERVER_ERROR];
  }
  Sentry.captureException(err);

  res.locals.errorMessage = err.message;

  const responseCode = err.errorCode || getErrorCode(statusCode);

  const response = {
    success: false,
    code: responseCode,
    message,
    // Array details (e.g. Zod field-level issues) are nested under `errors`.
    // Plain-object details (e.g. { emailVerified: false }) are spread at the
    // root so the frontend can read them directly (e.g. response.emailVerified).
    ...(Array.isArray(err.details)
      ? { errors: err.details }
      : err.details !== undefined && err.details),
  };

  if (config.env === 'development') {
    logger.error(err);
  }

  res.status(statusCode).send(response);
};

export { errorConverter, errorHandler };
