import type { Request, Response } from 'express';
import ApiResponse from '../../shared/utils/ApiResponse.ts';
import catchAsync from '../../shared/utils/catchAsync.ts';
import { getPaginationParams } from '../../shared/utils/pagination.ts';
import {
  auditActions,
  auditItemTypes,
  type AuditAction,
  type AuditItemType,
} from '../../db/index.ts';
import * as auditService from '../../services/audit/audit.service.ts';

// GET /api/v1/audit-logs  (super_admin only)
// Query params: page, limit, search, itemType, action, userId, from, to
export const listAuditLogs = catchAsync(
  async (req: Request, res: Response): Promise<void> => {
    const { page, limit, search } = getPaginationParams(
      req.query as Record<string, unknown>,
    );

    // Filters are validated defensively: an unknown value is ignored rather
    // than 400'd, so a stale bookmark or a hand-edited URL still renders.
    const itemType =
      typeof req.query.itemType === 'string' &&
      auditItemTypes.includes(req.query.itemType as AuditItemType)
        ? (req.query.itemType as AuditItemType)
        : undefined;

    const action =
      typeof req.query.action === 'string' &&
      auditActions.includes(req.query.action as AuditAction)
        ? (req.query.action as AuditAction)
        : undefined;

    const userId =
      typeof req.query.userId === 'string' && req.query.userId.trim().length > 0
        ? req.query.userId.trim()
        : undefined;

    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to);

    const result = await auditService.listAuditLogs({
      itemType,
      action,
      userId,
      from,
      to,
      search,
      page,
      limit,
    });

    res.status(200).json(
      ApiResponse.success('Audit logs retrieved successfully', {
        auditLogs: result.items,
        meta: result.meta,
      }),
    );
  },
);

/** Accepts YYYY-MM-DD only; anything else is dropped (returns undefined). */
function parseDateParam(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}
