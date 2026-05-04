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

import type { ObjectId, Plugin, RepositoryInstance } from '../types.js';
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
}

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
   * either in `pendingStatus` OR have an expired `leaseExpiresAt` (dead
   * lease recovery). Sets status to `processingStatus`, stamps
   * `leasedBy`, and pushes `leaseExpiresAt = now + leaseFor`.
   *
   * @returns The leased doc, or `null` when no row matches.
   */
  lease(opts: {
    filter?: Record<string, unknown>;
    leaseFor: number;
    leasedBy: string;
    options?: Record<string, unknown>;
  }): Promise<TDoc | null>;

  /**
   * Push a held lease's expiry further. Only succeeds when the lease
   * is still ours (`leasedBy === leasedBy && leaseExpiresAt > now`).
   * Returns `null` if the lease was lost — caller should drop the
   * work, since someone else has already started replaying it.
   */
  extend(
    id: string | ObjectId,
    opts: { leasedBy: string; leaseFor: number; options?: Record<string, unknown> },
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
   * expired / held by another worker / row gone).
   */
  release(
    id: string | ObjectId,
    opts: {
      leasedBy: string;
      finalStatus?: string;
      options?: Record<string, unknown>;
    },
  ): Promise<TDoc | null>;
}

export function leasePlugin(options: LeasePluginOptions = {}): Plugin {
  const statusField = options.statusField ?? 'status';
  const leasedByField = options.leasedByField ?? 'leasedBy';
  const leaseExpiresAtField = options.leaseExpiresAtField ?? 'leaseExpiresAt';
  const pendingStatus = options.pendingStatus ?? 'pending';
  const processingStatus = options.processingStatus ?? 'processing';
  const doneStatus = options.doneStatus ?? 'done';
  const sort = options.sort ?? { createdAt: 1 };

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
            options?: Record<string, unknown>;
          },
        ) {
          if (typeof opts?.leaseFor !== 'number' || opts.leaseFor <= 0) {
            throw createError(400, 'leasePlugin.lease: leaseFor must be a positive number (ms)');
          }
          if (typeof opts.leasedBy !== 'string' || opts.leasedBy.length === 0) {
            throw createError(400, 'leasePlugin.lease: leasedBy must be a non-empty string');
          }

          const now = new Date();
          const leaseUntil = new Date(now.getTime() + opts.leaseFor);

          // Match-condition: either pending OR a dead lease (`leaseExpiresAt
          // < now`). The `$or` covers both initial claims and recovery from
          // a worker that crashed mid-lease.
          const baseFilter = opts.filter ?? {};
          const claimFilter: Record<string, unknown> = {
            ...baseFilter,
            $or: [{ [statusField]: pendingStatus }, { [leaseExpiresAtField]: { $lt: now } }],
          };

          return this.findOneAndUpdate(
            claimFilter,
            {
              $set: {
                [statusField]: processingStatus,
                [leasedByField]: opts.leasedBy,
                [leaseExpiresAtField]: leaseUntil,
              },
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
          opts: { leasedBy: string; leaseFor: number; options?: Record<string, unknown> },
        ) {
          if (typeof opts?.leaseFor !== 'number' || opts.leaseFor <= 0) {
            throw createError(400, 'leasePlugin.extend: leaseFor must be a positive number (ms)');
          }
          const now = new Date();
          const leaseUntil = new Date(now.getTime() + opts.leaseFor);
          const idField = ((this as Record<string, unknown>).idField as string) || '_id';

          // CAS — only extend when the lease is still ours AND not expired.
          // If the lease is lost (someone else recovered the dead lease),
          // returning `null` lets the caller drop the work.
          return this.findOneAndUpdate(
            {
              [idField]: id,
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
          const now = new Date();
          const idField = ((this as Record<string, unknown>).idField as string) || '_id';

          // CAS — only the live holder may release. If the lease was
          // recovered (someone else now owns it) or expired, return null
          // so the caller knows their work was already taken over and
          // they must drop, not finalise.
          return this.findOneAndUpdate(
            {
              [idField]: id,
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
    },
  };
}
