/**
 * Idempotency-Store Plugin — keyed exactly-once operation claims
 * (the Stripe idempotency-key model, as a repository primitive).
 *
 * FOUR stores in the field hand-rolled the same protocol over `getOrCreate`
 * + a lease CAS: flow's `MongoIdempotencyStore`, cart's idempotency
 * repository, order's `OrderIdempotencyRepository` (adds saga progress +
 * lease tokens), and be-prod's refund-operation store (adds terminal-failure
 * replay + bounded attempts). This plugin standardises the SUPERSET so the
 * claim decision matrix — the part that makes a double execution
 * unrepresentable and a crash recoverable — isn't re-derived per repo.
 *
 * NOT the same primitive as `leasePlugin`: that one claims *the next pending
 * row* from a FIFO queue (outbox relays, waves). This one claims *a specific
 * deterministic key* exactly once, replays its durable outcome to retries,
 * and resumes crashed executions from persisted progress.
 *
 * ## The protocol
 *
 *   1. `claimKey(key)` BEFORE any work — atomic look-up-or-insert; exactly
 *      one concurrent caller acquires. Everyone else branches on the row's
 *      durable state: a finished execution replays (`completed` / `failed`),
 *      a live lease is `busy`, an expired lease is re-acquired by CAS
 *      (crash recovery — with the previous attempt's `progress` for resume),
 *      and an attempts ceiling (when configured) escalates to `exhausted`.
 *   2. `saveClaimProgress()` at each pivot — lease-token-guarded `$set` of
 *      resume data (e.g. "external side effect done: id X"). What makes a
 *      crash AFTER the side effect recoverable instead of ambiguous.
 *   3. `completeClaim(result)` / `failClaim(code)` — CAS to a terminal
 *      status; the stored outcome replays to every later claim of the key.
 *      Loses cleanly (no-op) if the lease was re-acquired meanwhile.
 *   4. `releaseClaim()` on definitive PRE-side-effect failure — deletes the
 *      caller's own in-flight row so a retry re-executes cleanly.
 *   5. `expireClaim()` on an AMBIGUOUS error — records the error and lapses
 *      the lease immediately so a recovery sweep re-claims without waiting.
 *
 * Every step is a single atomic round-trip through `Repository` verbs, so
 * multi-tenant / soft-delete / audit hooks all fire.
 *
 * ## Guarantee boundary
 *
 * Exactly-once EXECUTION CLAIM, not exactly-once side effect: the window
 * between an external side effect and `saveClaimProgress` is irreducible
 * from here. Close it by making the external call itself idempotent on the
 * same key (pass the key through to the provider — the Stripe model) or by
 * writing progress in the same transaction as a local side effect.
 *
 * Pluggable field names — existing stores use slightly different columns;
 * configure once at construction and adopt WITHOUT a data migration.
 *
 * @example
 * ```ts
 * type RefundOps = Repository<IRefundOp> & IdempotencyStoreMethods<PivotProgress, RefundResult>;
 * const repo = new Repository(RefundOpModel, [
 *   methodRegistryPlugin(),
 *   idempotencyStorePlugin({ keyField: 'operationId', maxAttempts: 5 }),
 * ]) as RefundOps;
 *
 * const claim = await repo.claimKey(operationId, { seed: { orderNumber, amount } });
 * switch (claim.kind) {
 *   case 'completed': return claim.result;                    // replay, no side effect
 *   case 'failed':    return replayFailure(claim.failureCode);
 *   case 'busy':      return conflict409();
 *   case 'exhausted': return escalateToHuman();
 *   case 'acquired':
 *     if (claim.progress?.externalId) {                        // crashed post-pivot → resume
 *       await finishLocalWork(claim.progress);
 *     } else {
 *       const ext = await provider.execute({ idempotencyKey: key });
 *       await repo.saveClaimProgress(key, claim.leaseToken, { externalId: ext.id });
 *       await finishLocalWork({ externalId: ext.id });
 *     }
 *     await repo.completeClaim(key, claim.leaseToken, result);
 * }
 * ```
 *
 * Schema recipe (host-owned model — this plugin never creates collections):
 * a unique index on the key field, a `{status, leaseExpiresAt}` recovery
 * index for sweeps, and a TTL on `createdAt` (records are ephemeral lease
 * state — TTL is never tenant-prefixed).
 */

import type { Plugin, RepositoryInstance } from '../types/repository.js';
import { createError } from '../utils/error.js';

export interface IdempotencyStorePluginOptions {
  /** Field carrying the deterministic operation key. @default `'key'` */
  keyField?: string;
  /** Field carrying the row's claim status. @default `'status'` */
  statusField?: string;
  /** Field carrying the current holder's lease token. @default `'leaseToken'` */
  leaseTokenField?: string;
  /** Field carrying the lease expiry timestamp. @default `'leaseExpiresAt'` */
  leaseExpiresAtField?: string;
  /** Field counting claim acquisitions (1 = first). @default `'attempts'` */
  attemptsField?: string;
  /** Field carrying saga resume data (Mixed). @default `'progress'` */
  progressField?: string;
  /** Field carrying the replayable success outcome (Mixed). @default `'result'` */
  resultField?: string;
  /** Field carrying the terminal failure code. @default `'failureCode'` */
  failureCodeField?: string;
  /** Field carrying the last error message (diagnostics). @default `'lastError'` */
  lastErrorField?: string;
  /** Status value of an in-flight claim. @default `'in_flight'` */
  inFlightStatus?: string;
  /** Terminal success status. @default `'succeeded'` */
  succeededStatus?: string;
  /** Terminal failure status. @default `'failed'` */
  failedStatus?: string;
  /** Claim lease (ms) — must outlive the longest guarded execution. @default 60_000 */
  defaultLeaseMs?: number;
  /**
   * Re-acquisition ceiling. When > 0, an expired in-flight claim whose
   * `attempts` already reached this value returns `exhausted` instead of
   * re-acquiring — the bounded-retry escalation valve for operations whose
   * external side effect is idempotent but may be wedged. 0 = unbounded
   * (flow/order semantics: recovery always re-claims). @default 0
   */
  maxAttempts?: number;
}

/** Outcome of `claimKey()` — the claim decision matrix. */
export type IdempotencyClaim<TProgress = Record<string, unknown>, TResult = unknown> =
  /**
   * This caller owns the lease — execute. `progress` present ⇒ a stale-lease
   * re-acquire after a previous attempt persisted resume data (crash
   * recovery): resume from it instead of re-running completed pivots.
   * `attempt` is 1 on a fresh claim.
   */
  | { kind: 'acquired'; leaseToken: string; attempt: number; progress?: TProgress }
  /** A previous execution succeeded — replay its stored outcome. */
  | { kind: 'completed'; result?: TResult }
  /** A previous execution failed terminally — replay the recorded code. */
  | { kind: 'failed'; failureCode?: string; error?: string }
  /** Another caller holds a live lease. `progress` (when persisted) lets a
   *  domain layer act on completed pivots without owning the lease — e.g.
   *  finish an idempotent post-pivot sync while the holder is wedged. */
  | { kind: 'busy'; progress?: TProgress; leaseToken?: string }
  /** `maxAttempts` re-acquisitions exhausted — escalate to a human. */
  | { kind: 'exhausted'; attempts: number; progress?: TProgress };

/**
 * Methods contributed by `idempotencyStorePlugin()`. Use as a type assertion
 * when constructing the repo (same convention as `LeaseMethods`).
 */
export interface IdempotencyStoreMethods<TProgress = Record<string, unknown>, TResult = unknown> {
  /**
   * Atomically claim `key`. Exactly one concurrent caller acquires; the rest
   * branch on the row's durable state — see {@link IdempotencyClaim}.
   *
   * `seed` merges extra fields into the row on FIRST insert only (domain
   * columns, tenant stamp). It never mutates an existing row.
   */
  claimKey(
    key: string,
    opts?: { leaseMs?: number; seed?: Record<string, unknown> },
  ): Promise<IdempotencyClaim<TProgress, TResult>>;

  /**
   * Persist saga resume data (post-pivot, pre-complete). Lease-token-guarded —
   * a stale crashed holder can't clobber a re-acquirer's record. Optional
   * `where` adds domain guards to the CAS filter.
   */
  saveClaimProgress(
    key: string,
    leaseToken: string,
    progress: TProgress,
    opts?: { where?: Record<string, unknown> },
  ): Promise<boolean>;

  /**
   * CAS the claim to the terminal SUCCESS status, storing `result` for
   * replay. Loses cleanly (returns false) when the lease was re-acquired.
   */
  completeClaim(
    key: string,
    leaseToken: string,
    result?: TResult,
    opts?: { where?: Record<string, unknown> },
  ): Promise<boolean>;

  /**
   * CAS the claim to the terminal FAILURE status. Later claims replay
   * `failureCode` instead of re-executing. Use ONLY for definitive failures
   * where the external side effect is known NOT to have happened.
   */
  failClaim(
    key: string,
    leaseToken: string,
    failure: { code: string; error?: string },
    opts?: { where?: Record<string, unknown> },
  ): Promise<boolean>;

  /**
   * Delete the caller's own in-flight row on definitive PRE-side-effect
   * failure so a retry re-executes cleanly. Never deletes a terminal row or
   * a re-acquired lease.
   */
  releaseClaim(key: string, leaseToken: string): Promise<boolean>;

  /**
   * Record an AMBIGUOUS error and lapse the lease immediately (keeps the row
   * in-flight) so a recovery sweep re-claims without waiting out the lease.
   * The bridge between "this attempt is giving up" and "the operation is not
   * over" — e.g. a network error mid-external-call.
   */
  expireClaim(key: string, leaseToken: string, opts?: { error?: string }): Promise<boolean>;
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function idempotencyStorePlugin(options: IdempotencyStorePluginOptions = {}): Plugin {
  const keyField = options.keyField ?? 'key';
  const statusField = options.statusField ?? 'status';
  const leaseTokenField = options.leaseTokenField ?? 'leaseToken';
  const leaseExpiresAtField = options.leaseExpiresAtField ?? 'leaseExpiresAt';
  const attemptsField = options.attemptsField ?? 'attempts';
  const progressField = options.progressField ?? 'progress';
  const resultField = options.resultField ?? 'result';
  const failureCodeField = options.failureCodeField ?? 'failureCode';
  const lastErrorField = options.lastErrorField ?? 'lastError';
  const inFlightStatus = options.inFlightStatus ?? 'in_flight';
  const succeededStatus = options.succeededStatus ?? 'succeeded';
  const failedStatus = options.failedStatus ?? 'failed';
  const defaultLeaseMs = options.defaultLeaseMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 0;

  return {
    name: 'idempotencyStore',

    apply(repo: RepositoryInstance): void {
      if (!repo.registerMethod) {
        throw new Error(
          'idempotencyStorePlugin requires methodRegistryPlugin. Add methodRegistryPlugin() before idempotencyStorePlugin().',
        );
      }

      const asDoc = (d: unknown): Record<string, unknown> => d as Record<string, unknown>;

      repo.registerMethod(
        'claimKey',
        async function (
          this: RepositoryInstance,
          key: string,
          opts: { leaseMs?: number; seed?: Record<string, unknown> } = {},
        ): Promise<IdempotencyClaim> {
          if (typeof key !== 'string' || key.length === 0) {
            throw createError(400, 'idempotencyStorePlugin.claimKey: key must be a non-empty string');
          }
          const leaseMs = opts.leaseMs ?? defaultLeaseMs;
          const now = new Date();
          const leaseToken = randomToken();

          const { doc, created } = await (
            this as unknown as {
              getOrCreate(
                q: Record<string, unknown>,
                d: Record<string, unknown>,
              ): Promise<{ doc: unknown; created: boolean }>;
            }
          ).getOrCreate(
            { [keyField]: key },
            {
              ...(opts.seed ?? {}),
              [keyField]: key,
              [statusField]: inFlightStatus,
              [leaseTokenField]: leaseToken,
              [leaseExpiresAtField]: new Date(now.getTime() + leaseMs),
              [attemptsField]: 1,
            },
          );
          if (created) return { kind: 'acquired', leaseToken, attempt: 1 };

          const row = asDoc(doc);
          // Terminal outcomes replay without re-executing anything.
          if (row[statusField] === succeededStatus) {
            return { kind: 'completed', result: row[resultField] };
          }
          if (row[statusField] === failedStatus) {
            return {
              kind: 'failed',
              failureCode: row[failureCodeField] as string | undefined,
              error: row[lastErrorField] as string | undefined,
            };
          }

          // In-flight. Live lease ⇒ a peer is mid-execution. Progress + token
          // are surfaced so a domain layer can act on completed pivots.
          const leaseExpiresAt = row[leaseExpiresAtField] as Date | undefined;
          const progress = row[progressField] as Record<string, unknown> | undefined;
          if (leaseExpiresAt && leaseExpiresAt > now) {
            return {
              kind: 'busy',
              ...(progress !== undefined ? { progress } : {}),
              ...(row[leaseTokenField] !== undefined ? { leaseToken: row[leaseTokenField] as string } : {}),
            };
          }

          // Expired lease ⇒ the holder crashed. Bounded escalation first…
          const attempts = (row[attemptsField] as number | undefined) ?? 1;
          if (maxAttempts > 0 && attempts >= maxAttempts) {
            return { kind: 'exhausted', attempts, ...(progress !== undefined ? { progress } : {}) };
          }
          // …then race-free re-acquisition: of N concurrent recoverers over a
          // stale claim, exactly one CAS matches.
          const reclaimed = await this.findOneAndUpdate(
            { [keyField]: key, [statusField]: inFlightStatus, [leaseExpiresAtField]: { $lte: now } },
            {
              $set: { [leaseTokenField]: leaseToken, [leaseExpiresAtField]: new Date(now.getTime() + leaseMs) },
              $inc: { [attemptsField]: 1 },
            },
            { returnDocument: 'after' },
          );
          if (reclaimed) {
            const rec = asDoc(reclaimed);
            const recProgress = rec[progressField] as Record<string, unknown> | undefined;
            return {
              kind: 'acquired',
              leaseToken,
              attempt: (rec[attemptsField] as number | undefined) ?? attempts + 1,
              ...(recProgress !== undefined ? { progress: recProgress } : {}),
            };
          }
          // Lost the re-acquisition race — the winner is now mid-execution.
          return { kind: 'busy', ...(progress !== undefined ? { progress } : {}) };
        },
      );

      repo.registerMethod(
        'saveClaimProgress',
        async function (
          this: RepositoryInstance,
          key: string,
          leaseToken: string,
          progress: Record<string, unknown>,
          opts: { where?: Record<string, unknown> } = {},
        ): Promise<boolean> {
          const updated = await this.findOneAndUpdate(
            {
              ...(opts.where ?? {}),
              [keyField]: key,
              [leaseTokenField]: leaseToken,
              [statusField]: inFlightStatus,
            },
            { $set: { [progressField]: progress } },
            { returnDocument: 'after' },
          );
          return updated !== null;
        },
      );

      repo.registerMethod(
        'completeClaim',
        async function (
          this: RepositoryInstance,
          key: string,
          leaseToken: string,
          result?: unknown,
          opts: { where?: Record<string, unknown> } = {},
        ): Promise<boolean> {
          const updated = await this.findOneAndUpdate(
            {
              ...(opts.where ?? {}),
              [keyField]: key,
              [leaseTokenField]: leaseToken,
              [statusField]: inFlightStatus,
            },
            { $set: { [statusField]: succeededStatus, ...(result !== undefined ? { [resultField]: result } : {}) } },
            { returnDocument: 'after' },
          );
          return updated !== null;
        },
      );

      repo.registerMethod(
        'failClaim',
        async function (
          this: RepositoryInstance,
          key: string,
          leaseToken: string,
          failure: { code: string; error?: string },
          opts: { where?: Record<string, unknown> } = {},
        ): Promise<boolean> {
          if (!failure || typeof failure.code !== 'string' || failure.code.length === 0) {
            throw createError(400, 'idempotencyStorePlugin.failClaim: failure.code must be a non-empty string');
          }
          const updated = await this.findOneAndUpdate(
            {
              ...(opts.where ?? {}),
              [keyField]: key,
              [leaseTokenField]: leaseToken,
              [statusField]: inFlightStatus,
            },
            {
              $set: {
                [statusField]: failedStatus,
                [failureCodeField]: failure.code,
                ...(failure.error !== undefined ? { [lastErrorField]: failure.error } : {}),
              },
            },
            { returnDocument: 'after' },
          );
          return updated !== null;
        },
      );

      repo.registerMethod(
        'releaseClaim',
        async function (this: RepositoryInstance, key: string, leaseToken: string): Promise<boolean> {
          // `deleteMany` is a Repository primitive not declared on the narrow
          // RepositoryInstance surface — same structural cast as getOrCreate.
          const res: unknown = await (
            this as unknown as {
              deleteMany(q: Record<string, unknown>): Promise<{ deletedCount?: number } | number | null>;
            }
          ).deleteMany({
            [keyField]: key,
            [leaseTokenField]: leaseToken,
            [statusField]: inFlightStatus,
          });
          const count =
            typeof res === 'number' ? res : ((res as { deletedCount?: number } | null)?.deletedCount ?? 0);
          return count > 0;
        },
      );

      repo.registerMethod(
        'expireClaim',
        async function (
          this: RepositoryInstance,
          key: string,
          leaseToken: string,
          opts: { error?: string } = {},
        ): Promise<boolean> {
          const updated = await this.findOneAndUpdate(
            { [keyField]: key, [leaseTokenField]: leaseToken, [statusField]: inFlightStatus },
            {
              $set: {
                [leaseExpiresAtField]: new Date(),
                ...(opts.error !== undefined ? { [lastErrorField]: opts.error } : {}),
              },
            },
            { returnDocument: 'after' },
          );
          return updated !== null;
        },
      );
    },
  };
}
