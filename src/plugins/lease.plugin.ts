/**
 * Lease Plugin — distributed FIFO claim-lease pattern.
 *
 * Five repos in the field hand-rolled the same `findOneAndUpdate({
 * status: 'pending', leaseExpiresAt: { $lt: now } }, { $set: { status:
 * 'processing', leasedBy, leaseExpiresAt: until } }, { sort: { createdAt:
 * 1 } })` shape: outbox relays, flow waves, promo pending-evaluation,
 * fulfillment retry, cart idempotency. This plugin standardises the
 * trio so dead-lease recovery semantics aren't re-derived per repo.
 *
 * Three contributed methods:
 *   - `lease(opts)` — atomically claim the next pending or dead-leased
 *     row matching `filter`. Returns the leased doc or `null` when the
 *     queue is empty / fully leased.
 *   - `extend(id, leaseFor)` — push `leaseExpiresAt` further; returns
 *     the updated doc or `null` if the lease was lost (someone else
 *     claimed it after expiry).
 *   - `release(id, opts)` — mark the row as terminal (`done` by
 *     default) and clear the lease. CAS-checks `leasedBy` + a still-
 *     live `leaseExpiresAt` — only the worker holding a non-expired
 *     lease may finalise it. `release(id, { leasedBy, finalStatus:
 *     'failed' })` for error paths.
 *   - `reapExhausted(opts)` — with `maxAttempts`: move rows the cap
 *     keeps from being leased (lease lapsed, or pending) to
 *     `exhaustedStatus` and return them, for the host to audit / alert.
 *
 * Pluggable field names — every leasable model is slightly different
 * (some use `lockedBy` / `lockExpiresAt`, some use `leasedBy` /
 * `leaseExpiresAt`). Configure once at construction; the methods key
 * off the resolved names.
 *
 * Multi-tenant + soft-delete + audit hooks all fire — methods route
 * through `Repository.findOneAndUpdate` so the existing hook pipeline
 * picks them up. The hand-rolled implementations bypassed the pipeline,
 * which is the kind of silent-tenant-leak the central plugin closes.
 */

import type { ObjectId } from '../types/core.js';
import type { Plugin, RepositoryInstance } from '../types/repository.js';
import { createError } from '../utils/error.js';

export interface LeasePluginOptions {
  /** Field carrying the row's status. @default `'status'` */
  statusField?: string;
  /** Field stamping the lease holder. @default `'leasedBy'` */
  leasedByField?: string;
  /** Field carrying the lease expiry timestamp. @default `'leaseExpiresAt'` */
  leaseExpiresAtField?: string;
  /** Status value an unleased row carries. @default `'pending'` */
  pendingStatus?: string;
  /** Status value a leased row carries. @default `'processing'` */
  processingStatus?: string;
  /** Status value a successfully released row carries. @default `'done'` */
  doneStatus?: string;
  /** Sort fields used to pick the FIFO winner from the lease pool. @default `{ createdAt: 1 }` */
  sort?: Record<string, 1 | -1>;
  /**
   * Clock used by `lease` / `extend` / `release` for both the CAS
   * comparison and the new expiry. A per-call `now` wins over it.
   * Inject one to drive lease expiry from a test or a host `Clock`
   * port. @default `() => new Date()`
   */
  nowFn?: () => Date;
  /**
   * Statuses whose expired lease `lease()` may recover. Only rows in
   * one of these statuses AND with `leaseExpiresAt < now` are dead
   * leases; a row in any other status is never re-leased, whatever its
   * lease field says (a cancelled row with a stale expiry stays
   * cancelled). @default `[processingStatus]`
   */
  deadLeaseStatuses?: readonly string[];
  /**
   * Optional attempts counter. When set, every successful `lease()`
   * (first claim and dead-lease recovery alike) applies
   * `$inc: { [attemptsField]: 1 }`. Off by default.
   */
  attemptsField?: string;
  /**
   * Cap on `attemptsField`. A row whose counter is already
   * `>= maxAttempts` is not leasable; a row missing the field is.
   * Exhausted rows stay where they are until `reapExhausted()` moves
   * them to `exhaustedStatus` (or the host sweeps them itself).
   * Requires `attemptsField` (throws at construction).
   */
  maxAttempts?: number;
  /**
   * Terminal status `reapExhausted()` moves an exhausted row to (e.g.
   * `'failed'`). Requires `maxAttempts`; must differ from
   * `pendingStatus`, `processingStatus` and every `deadLeaseStatuses`
   * entry (throws at construction). Without it `reapExhausted()` needs
   * a per-call `status`.
   */
  exhaustedStatus?: string;
  /** Field `reapExhausted()` stamps with the reap time (e.g. `'failedAt'`). Off by default. */
  exhaustedAtField?: string;
  /**
   * Extra predicate ANDed into the PENDING arm only, so not-yet-due rows
   * wait while a dead lease is still recovered. The object form is
   * STATIC (built once); for a time-relative predicate pass the function
   * form, called per `lease()` with the resolved `now` (per-call `now`,
   * else `nowFn()`): `pendingFilter: (now) => ({ dueAt: { $lte: now } })`.
   * A per-call `pendingFilter` replaces this one.
   */
  pendingFilter?: LeasePendingFilter;
}

/** Static pending-arm predicate, or a builder called with the claim's `now`. */
export type LeasePendingFilter = Record<string, unknown> | ((now: Date) => Record<string, unknown>);

/**
 * Methods contributed by `leasePlugin()`. Use as a type assertion when
 * constructing the repo so call sites get autocomplete:
 *
 * ```ts
 * type OutboxRepo = Repository<IOutboxRow> & LeaseMethods<IOutboxRow>;
 * const repo = new Repository(OutboxModel, [
 *   methodRegistryPlugin(),
 *   leasePlugin({ pendingStatus: 'queued' }),
 * ]) as OutboxRepo;
 * ```
 */
export interface LeaseMethods<TDoc> {
  /**
   * Atomically claim the next available row. Matches rows that are
   * either in `pendingStatus` (AND `pendingFilter`, when given) OR in a
   * `deadLeaseStatuses` status with an expired `leaseExpiresAt` (dead
   * lease recovery). The caller's `filter` is kept as given (its own
   * `$or` included) and the claim condition is ANDed beside it. Sets
   * status to `processingStatus`, stamps `leasedBy`, pushes
   * `leaseExpiresAt = now + leaseFor`, and bumps `attemptsField` when
   * configured.
   *
   * `leasedBy` is the fencing token for `extend` / `release`: make it
   * unique per claim (e.g. `${instanceId}:${randomUUID()}`). A worker
   * that reuses one id could otherwise finalise a stale run after its
   * own lapsed lease was re-leased under the same id.
   *
   * @returns The leased doc, or `null` when no row matches.
   */
  lease(opts: {
    filter?: Record<string, unknown>;
    leaseFor: number;
    leasedBy: string;
    /** Clock reading for this call. @default plugin `nowFn()` */
    now?: Date;
    /** Replaces the plugin-level `pendingFilter` for this call. */
    pendingFilter?: LeasePendingFilter;
    options?: Record<string, unknown>;
  }): Promise<TDoc | null>;

  /**
   * Push a held lease's expiry further. Only succeeds when the lease
   * is still ours (`leasedBy === leasedBy && leaseExpiresAt > now`) and
   * the row is still in `processingStatus` (a row the host moved to a
   * terminal status, e.g. cancelled, is not kept alive).
   * Returns `null` if the lease was lost — caller should drop the
   * work, since someone else has already started replaying it.
   */
  extend(
    id: string | ObjectId,
    opts: { leasedBy: string; leaseFor: number; now?: Date; options?: Record<string, unknown> },
  ): Promise<TDoc | null>;

  /**
   * Release a held lease. CAS-checks `leasedBy === opts.leasedBy` AND
   * `leaseExpiresAt > now` so only the live lease holder may finalise
   * the row — symmetrical with `extend()`. A worker whose lease has
   * been recovered (lease lost) MUST NOT mark someone else's
   * in-progress work as `done` / `failed`; this method returns `null`
   * in that race rather than overwriting.
   *
   * Sets status to `opts.finalStatus` (default `doneStatus`), clears
   * `leasedBy` and `leaseExpiresAt`. Use `{ finalStatus: 'failed' }`
   * for error paths so terminal-status filters (next caller's
   * `lease()` predicate) skip this row.
   *
   * Returns the released doc, or `null` when the CAS lost (lease
   * expired / held by another worker / row gone / row no longer in
   * `processingStatus`, e.g. the host cancelled it mid-run).
   */
  release(
    id: string | ObjectId,
    opts: {
      leasedBy: string;
      finalStatus?: string;
      now?: Date;
      options?: Record<string, unknown>;
    },
  ): Promise<TDoc | null>;

  /**
   * Move every EXHAUSTED row to `exhaustedStatus` and return the moved
   * rows (after the move), so the host only audits and alerts. A row is
   * exhausted when `lease()` would claim it but for the attempts cap:
   * `attemptsField >= maxAttempts` AND either pending (and passing
   * `pendingFilter`) or in a `deadLeaseStatuses` status whose lease
   * lapsed (`leaseExpiresAt < now`). A row whose lease is still live is
   * left alone: its holder may still release it.
   *
   * Each move is a compare-and-set on that same condition, so two
   * reapers never both return a row, and a row is returned once: once
   * moved it no longer matches. Clears `leasedBy` / `leaseExpiresAt`
   * and stamps `exhaustedAtField` with `now` when configured. The
   * caller's `filter` is ANDed in as with `lease()`. Requires
   * `maxAttempts`; reads at most `limit` rows (default 100) in `sort`
   * order, so call it again until it returns `[]`. A batch shorter than
   * `limit` does not mean none are left: a concurrent reaper may have
   * moved some of the rows read (and keeps draining them).
   */
  reapExhausted(opts?: {
    filter?: Record<string, unknown>;
    /** Clock reading for this call. @default plugin `nowFn()` */
    now?: Date;
    /** Rows read per call. @default 100 */
    limit?: number;
    /** Replaces the plugin-level `exhaustedStatus` for this call. */
    status?: string;
    /** Replaces the plugin-level `pendingFilter` for this call. */
    pendingFilter?: LeasePendingFilter;
    options?: Record<string, unknown>;
  }): Promise<TDoc[]>;
}

function isNonEmpty(obj: Record<string, unknown> | undefined): obj is Record<string, unknown> {
  return obj !== undefined && obj !== null && Object.keys(obj).length > 0;
}

export function leasePlugin(options: LeasePluginOptions = {}): Plugin {
  const statusField = options.statusField ?? 'status';
  const leasedByField = options.leasedByField ?? 'leasedBy';
  const leaseExpiresAtField = options.leaseExpiresAtField ?? 'leaseExpiresAt';
  const pendingStatus = options.pendingStatus ?? 'pending';
  const processingStatus = options.processingStatus ?? 'processing';
  const doneStatus = options.doneStatus ?? 'done';
  const sort = options.sort ?? { createdAt: 1 };
  const nowFn = options.nowFn ?? (() => new Date());
  const deadLeaseStatuses = options.deadLeaseStatuses ?? [processingStatus];
  const attemptsField = options.attemptsField;
  const maxAttempts = options.maxAttempts;
  if (deadLeaseStatuses.length === 0) {
    throw new Error('leasePlugin: deadLeaseStatuses must name at least one status');
  }
  if (maxAttempts !== undefined) {
    if (attemptsField === undefined) {
      throw new Error('leasePlugin: maxAttempts requires attemptsField');
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('leasePlugin: maxAttempts must be a positive integer');
    }
  }
  const exhaustedStatus = options.exhaustedStatus;
  const exhaustedAtField = options.exhaustedAtField;
  const assertTerminal = (where: string, status: string): void => {
    if (
      status === pendingStatus ||
      status === processingStatus ||
      deadLeaseStatuses.includes(status)
    ) {
      // A reaped row in a leasable status would be claimed (or reaped) again.
      throw new Error(
        `leasePlugin: ${where} "${status}" must differ from the pending, processing and dead-lease statuses`,
      );
    }
  };
  if (exhaustedStatus !== undefined) {
    if (maxAttempts === undefined) {
      throw new Error('leasePlugin: exhaustedStatus requires maxAttempts');
    }
    assertTerminal('exhaustedStatus', exhaustedStatus);
  }
  if (exhaustedAtField !== undefined && maxAttempts === undefined) {
    throw new Error('leasePlugin: exhaustedAtField requires maxAttempts');
  }

  /**
   * The claim condition: pending (narrowed by `pendingFilter`) OR a dead
   * lease, a row still in a dead-lease status whose `leaseExpiresAt <
   * now` (worker crashed mid-lease). The status guard on the dead arm
   * keeps a cancelled / terminal row with a stale expiry from being
   * revived. `lease()` adds "under the attempts cap"; `reapExhausted()`
   * adds "at or over it".
   */
  const claimable = (now: Date, pendingSource: LeasePendingFilter | undefined) => {
    const pendingFilter = typeof pendingSource === 'function' ? pendingSource(now) : pendingSource;
    const pendingArm: Record<string, unknown> = isNonEmpty(pendingFilter)
      ? { $and: [{ [statusField]: pendingStatus }, pendingFilter] }
      : { [statusField]: pendingStatus };
    const deadArm: Record<string, unknown> = {
      [statusField]:
        deadLeaseStatuses.length === 1 ? deadLeaseStatuses[0] : { $in: deadLeaseStatuses },
      [leaseExpiresAtField]: { $lt: now },
    };
    return { $or: [pendingArm, deadArm] };
  };

  /** The caller's filter as given, with `conditions` ANDed beside it. */
  const withConditions = (
    method: string,
    baseFilter: Record<string, unknown>,
    conditions: Record<string, unknown>[],
  ): Record<string, unknown> => {
    if (baseFilter.$and !== undefined && !Array.isArray(baseFilter.$and)) {
      throw createError(400, `leasePlugin.${method}: filter.$and must be an array`);
    }
    const callerAnd = (baseFilter.$and as Record<string, unknown>[] | undefined) ?? [];
    return { ...baseFilter, $and: [...callerAnd, ...conditions] };
  };

  const resolveNow = (method: string, perCall: Date | undefined): Date => {
    const now = perCall ?? nowFn();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw createError(400, `leasePlugin.${method}: now must be a valid Date`);
    }
    return now;
  };
  const assertLeasedBy = (method: string, leasedBy: unknown): void => {
    if (typeof leasedBy !== 'string' || leasedBy.length === 0) {
      throw createError(400, `leasePlugin.${method}: leasedBy must be a non-empty string`);
    }
  };

  return {
    name: 'lease',

    apply(repo: RepositoryInstance): void {
      if (!repo.registerMethod) {
        throw new Error(
          'leasePlugin requires methodRegistryPlugin. Add methodRegistryPlugin() before leasePlugin().',
        );
      }

      /**
       * Atomic FIFO lease claim — the canonical
       *   findOneAndUpdate({ status: pending, OR leaseExpiresAt < now },
       *                    { $set: { status: processing, leasedBy, leaseExpiresAt } },
       *                    { sort })
       * pattern, distilled.
       */
      repo.registerMethod(
        'lease',
        async function (
          this: RepositoryInstance,
          opts: {
            filter?: Record<string, unknown>;
            leaseFor: number;
            leasedBy: string;
            now?: Date;
            pendingFilter?: LeasePendingFilter;
            options?: Record<string, unknown>;
          },
        ) {
          if (typeof opts?.leaseFor !== 'number' || opts.leaseFor <= 0) {
            throw createError(400, 'leasePlugin.lease: leaseFor must be a positive number (ms)');
          }
          assertLeasedBy('lease', opts.leasedBy);

          const now = resolveNow('lease', opts.now);
          const leaseUntil = new Date(now.getTime() + opts.leaseFor);

          const conditions: Record<string, unknown>[] = [
            claimable(now, opts.pendingFilter ?? options.pendingFilter),
          ];
          if (attemptsField !== undefined && maxAttempts !== undefined) {
            // `$not: { $gte }` also matches rows that lack the counter.
            conditions.push({ [attemptsField]: { $not: { $gte: maxAttempts } } });
          }

          // The caller's filter stays as given (plain keys and its own
          // `$or` at the top level, where tenant / soft-delete plugins
          // expect them); the claim condition joins through `$and`.
          const claimFilter = withConditions('lease', opts.filter ?? {}, conditions);

          return this.findOneAndUpdate(
            claimFilter,
            {
              $set: {
                [statusField]: processingStatus,
                [leasedByField]: opts.leasedBy,
                [leaseExpiresAtField]: leaseUntil,
              },
              ...(attemptsField !== undefined ? { $inc: { [attemptsField]: 1 } } : {}),
            },
            {
              ...(opts.options ?? {}),
              sort,
              returnDocument: 'after',
            },
          );
        },
      );

      repo.registerMethod(
        'extend',
        async function (
          this: RepositoryInstance,
          id: string | ObjectId,
          opts: {
            leasedBy: string;
            leaseFor: number;
            now?: Date;
            options?: Record<string, unknown>;
          },
        ) {
          if (typeof opts?.leaseFor !== 'number' || opts.leaseFor <= 0) {
            throw createError(400, 'leasePlugin.extend: leaseFor must be a positive number (ms)');
          }
          assertLeasedBy('extend', opts.leasedBy);
          const now = resolveNow('extend', opts.now);
          const leaseUntil = new Date(now.getTime() + opts.leaseFor);
          const idField = ((this as Record<string, unknown>).idField as string) || '_id';

          // CAS — only extend when the lease is still ours AND not expired.
          // If the lease is lost (someone else recovered the dead lease),
          // returning `null` lets the caller drop the work.
          return this.findOneAndUpdate(
            {
              [idField]: id,
              [statusField]: processingStatus,
              [leasedByField]: opts.leasedBy,
              [leaseExpiresAtField]: { $gt: now },
            },
            { $set: { [leaseExpiresAtField]: leaseUntil } },
            { ...(opts.options ?? {}), returnDocument: 'after' },
          );
        },
      );

      repo.registerMethod(
        'release',
        async function (
          this: RepositoryInstance,
          id: string | ObjectId,
          opts: {
            leasedBy: string;
            finalStatus?: string;
            now?: Date;
            options?: Record<string, unknown>;
          },
        ) {
          if (typeof opts?.leasedBy !== 'string' || opts.leasedBy.length === 0) {
            throw createError(
              400,
              'leasePlugin.release: leasedBy must be a non-empty string (the holder finalising the lease)',
            );
          }
          const finalStatus = opts.finalStatus ?? doneStatus;
          const now = resolveNow('release', opts.now);
          const idField = ((this as Record<string, unknown>).idField as string) || '_id';

          // CAS — only the live holder may release. If the lease was
          // recovered (someone else now owns it) or expired, return null
          // so the caller knows their work was already taken over and
          // they must drop, not finalise.
          return this.findOneAndUpdate(
            {
              [idField]: id,
              [statusField]: processingStatus,
              [leasedByField]: opts.leasedBy,
              [leaseExpiresAtField]: { $gt: now },
            },
            {
              $set: { [statusField]: finalStatus },
              $unset: { [leasedByField]: '', [leaseExpiresAtField]: '' },
            },
            { ...(opts.options ?? {}), returnDocument: 'after' },
          );
        },
      );

      repo.registerMethod(
        'reapExhausted',
        async function (
          this: RepositoryInstance,
          opts: {
            filter?: Record<string, unknown>;
            now?: Date;
            limit?: number;
            status?: string;
            pendingFilter?: LeasePendingFilter;
            options?: Record<string, unknown>;
          } = {},
        ) {
          if (attemptsField === undefined || maxAttempts === undefined) {
            throw createError(400, 'leasePlugin.reapExhausted: requires maxAttempts');
          }
          const status = opts.status ?? exhaustedStatus;
          if (typeof status !== 'string' || status.length === 0) {
            throw createError(
              400,
              'leasePlugin.reapExhausted: pass a status, or configure exhaustedStatus',
            );
          }
          if (opts.status !== undefined) {
            try {
              assertTerminal('reapExhausted status', status);
            } catch (err) {
              throw createError(400, (err as Error).message);
            }
          }
          const limit = opts.limit ?? 100;
          if (!Number.isInteger(limit) || limit < 1) {
            throw createError(400, 'leasePlugin.reapExhausted: limit must be a positive integer');
          }
          const now = resolveNow('reapExhausted', opts.now);
          const exhausted = withConditions('reapExhausted', opts.filter ?? {}, [
            claimable(now, opts.pendingFilter ?? options.pendingFilter),
            { [attemptsField]: { $gte: maxAttempts } },
          ]);
          const idField = ((this as Record<string, unknown>).idField as string) || '_id';
          const findAll = this.findAll as (
            filter: Record<string, unknown>,
            options: Record<string, unknown>,
          ) => Promise<Array<Record<string, unknown>>>;
          const candidates = await findAll.call(this, exhausted, {
            ...(opts.options ?? {}),
            sort,
            limit,
            lean: true,
          });

          const reaped: unknown[] = [];
          for (const row of candidates) {
            // CAS on the whole exhausted condition: a lease extended or a
            // row moved since the read no longer matches, and a second
            // reaper finds nothing to move.
            const moved = await this.findOneAndUpdate(
              { ...exhausted, [idField]: row[idField] },
              {
                $set: {
                  [statusField]: status,
                  ...(exhaustedAtField !== undefined ? { [exhaustedAtField]: now } : {}),
                },
                $unset: { [leasedByField]: '', [leaseExpiresAtField]: '' },
              },
              { ...(opts.options ?? {}), returnDocument: 'after' },
            );
            if (moved) reaped.push(moved);
          }
          return reaped;
        },
      );
    },
  };
}
