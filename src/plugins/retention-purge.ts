/**
 * Retention purge: the ONE public way to physically remove rows that an
 * integrity fence (`appendOnlyPlugin`, `immutableStatesPlugin`) otherwise
 * refuses to delete.
 *
 * A call opts in with `retentionPurge: { reason, actor? }` plus
 * `mode: 'hard'` on `delete` / `deleteMany`, or with
 * `purgeByFilter(filter, { type: 'hard' }, { retentionPurge })` /
 * `purgeByField(...)`, which forward it to every chunk's `deleteMany`.
 * Each fence honours it only when the plugin was constructed with
 * `allowPurge: true`, and emits its own audit event per successful call
 * (`after:append-only-purge`, `after:immutable-states-purge`) carrying the
 * reason, actor, target and `deletedCount`. The option never unlocks an
 * edit: on any op other than a delete it is ignored and the fence applies.
 */

import type { RepositoryContext } from '../types/repository.js';
import { createError } from '../utils/error.js';

/** Per-call retention purge request (`options.retentionPurge`). */
export interface RetentionPurgeRequest {
  /** Why the rows are removed (e.g. `'retention: 7 years'`). Required, non-blank. */
  reason: string;
  /** Who or what purges (user id, `'job:retention'`). Carried to the audit events. */
  actor?: string | undefined;
}

/** Common payload of the per-plugin purge audit events, one per successful delete call. */
export interface RetentionPurgeEvent {
  operation: 'delete' | 'deleteMany';
  reason: string;
  actor: string | undefined;
  /** `delete`: the id. */
  id: unknown;
  /** `deleteMany`: the final filter (after policy hooks such as tenant scope). */
  filter: Record<string, unknown> | undefined;
  /** Rows removed (`delete`: 1 or 0). */
  deletedCount: number;
  /**
   * The delete's session, when the call ran in one. Write the audit row with it
   * (`{ session: event.session }`) so the delete and its audit commit or abort
   * together. Listeners are awaited and a throwing one fails the purge call.
   */
  session: unknown;
  context: RepositoryContext;
}

/** Error codes thrown for a malformed or unauthorized retention purge. */
export const RETENTION_PURGE_ERROR_CODES = {
  DISABLED: 'RETENTION_PURGE_DISABLED',
  REASON_REQUIRED: 'RETENTION_PURGE_REASON_REQUIRED',
  INVALID_ACTOR: 'RETENTION_PURGE_INVALID_ACTOR',
  HARD_ONLY: 'RETENTION_PURGE_HARD_ONLY',
} as const;

/** Validates the request's shape (reason, actor). Throws 400 on a malformed one. */
export function assertRetentionPurgeShape(raw: unknown, op: string): RetentionPurgeRequest {
  const req = raw as Partial<RetentionPurgeRequest> | null;
  if (!req || typeof req !== 'object' || typeof req.reason !== 'string' || !req.reason.trim()) {
    throw createError(400, `'${op}' with retentionPurge needs a non-blank reason.`, {
      code: RETENTION_PURGE_ERROR_CODES.REASON_REQUIRED,
      meta: { operation: op },
    });
  }
  if (req.actor !== undefined && (typeof req.actor !== 'string' || !req.actor.trim())) {
    throw createError(400, `'${op}' with retentionPurge: actor must be a non-blank string.`, {
      code: RETENTION_PURGE_ERROR_CODES.INVALID_ACTOR,
      meta: { operation: op },
    });
  }
  return { reason: req.reason, actor: req.actor };
}

/**
 * The validated purge request on a delete context, or `undefined` for an
 * ordinary delete. Refuses every malformed or unauthorized form rather than
 * falling back to the fence: a purge that silently became a refused delete
 * would hide the misconfiguration from the job.
 */
export function readRetentionPurge(
  ctx: RepositoryContext,
  op: string,
  guard: { plugin: string; allowPurge: boolean },
): RetentionPurgeRequest | undefined {
  const raw = (ctx as { retentionPurge?: unknown }).retentionPurge;
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (!guard.allowPurge) {
    throw createError(
      403,
      `'${op}' with retentionPurge is not enabled on this repository: construct ` +
        `${guard.plugin} with allowPurge: true for the retention path.`,
      {
        code: RETENTION_PURGE_ERROR_CODES.DISABLED,
        meta: { operation: op, plugin: guard.plugin },
      },
    );
  }
  const req = assertRetentionPurgeShape(raw, op);
  if ((ctx as { deleteMode?: unknown }).deleteMode !== 'hard') {
    throw createError(
      400,
      `'${op}' with retentionPurge must be a physical delete: pass mode: 'hard'.`,
      { code: RETENTION_PURGE_ERROR_CODES.HARD_ONLY, meta: { operation: op } },
    );
  }
  return req;
}

/** Builds the common audit payload from an `after:delete` / `after:deleteMany` emission. */
export function retentionPurgeEvent(
  operation: RetentionPurgeEvent['operation'],
  context: RepositoryContext,
  result: unknown,
): RetentionPurgeEvent | undefined {
  const req = (context as { retentionPurge?: RetentionPurgeRequest }).retentionPurge;
  if (!req || typeof req !== 'object') return undefined;
  const ctx = context as { id?: unknown; query?: Record<string, unknown> };
  return {
    operation,
    reason: req.reason,
    actor: req.actor,
    id: operation === 'delete' ? ctx.id : undefined,
    filter: operation === 'deleteMany' ? ctx.query : undefined,
    deletedCount:
      operation === 'delete'
        ? result
          ? 1
          : 0
        : ((result as { deletedCount?: number } | undefined)?.deletedCount ?? 0),
    session: (context as { session?: unknown }).session,
    context,
  };
}
