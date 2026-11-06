/**
 * Append-Only Plugin
 *
 * Turns a repository into an immutable-facts ledger: inserts land,
 * everything else is refused at POLICY priority. The enforcement
 * layer for event-sourced planes — flow's `StockEvent`,
 * manufacturing's `ProductionEvent`, audit sinks, outbox archives —
 * where a mutable row would silently corrupt the audit/time-travel
 * story that the whole collection exists to provide.
 *
 * Grep-proof by construction: hand-fenced `update()`/`delete()`
 * overrides only cover the verbs someone remembered to override; this
 * plugin derives coverage from `OP_REGISTRY`, so every mutating op —
 * including `claim`, `claimVersion`, `restore`, `bulkWrite`, and any
 * op added to the registry later — is refused automatically.
 *
 * Allowed by default: `create`, `createMany` (appends). `getOrCreate`
 * is registry-classified as a read and stays available — it can only
 * INSERT or return the existing row, never mutate one, which is
 * append-safe by definition (idempotency stores rely on it).
 * Refused by default: `update`, `findOneAndUpdate`, `updateMany`,
 * `delete`, `deleteMany`, `restore`, `claim`, `claimVersion`,
 * `bulkWrite` (wholesale — mixed insert/update batches are ambiguous;
 * append via `createMany` instead). Composed methods from other
 * plugins (`incrementIfBelow`, lease ops) decompose into these
 * registry ops internally, so the fence catches them too.
 *
 * TTL indexes are unaffected (server-side GC never touches the repo
 * layer) — TTL-expiring an idempotency ledger still works. Raw
 * `Model.*` driver calls bypass every plugin, this one included —
 * the org-wide "never drop to Model.deleteOne" rule is what covers
 * that hole, same as for tenant scope.
 *
 * **Escape hatches** (both audited via `after:append-only-bypass`):
 *   - Plugin-level `allow` — ops the DOMAIN legitimately needs, wired
 *     once at construction (e.g. `allow: ['deleteMany']` for a
 *     GDPR-erasure path the host gates behind admin roles).
 *   - Per-call `bypassAppendOnly: true` — deliberate one-off
 *     maintenance (backfill repair, migration), grep-auditable at the
 *     call site.
 *
 * **Retention purge** (`allowPurge: true`): the one public path for a
 * retention job to physically remove rows. Pass
 * `retentionPurge: { reason, actor? }` with `mode: 'hard'` on `delete` /
 * `deleteMany`, or run `purgeByFilter(filter, { type: 'hard' },
 * { retentionPurge })` / `purgeByField(...)`, which forward it to every
 * chunk. Each successful call emits `after:append-only-purge`
 * ({@link AppendOnlyPurgeEvent}) with the reason, actor, target and
 * `deletedCount`. Without `allowPurge`, a missing reason or `mode: 'hard'`
 * the call is refused; on any other op the option is ignored (the fence
 * applies). The same option is honoured by `immutableStatesPlugin`, so a
 * repository with both plugins purges through one call. Prefer it over
 * `bypassAppendOnly` for retention: it is delete-only and carries a reason.
 * `allowArchive: true` admits only `archiveByFilter`'s attested chunk deletes.
 *
 * `skipPlugins` is deliberately IGNORED — same policy as tenant scope
 * and soft delete: integrity fences don't have a convenience bypass.
 *
 * @example
 * const events = new Repository(StockEventModel, [
 *   multiTenantPlugin({ ... }),
 *   appendOnlyPlugin(),
 * ]);
 * await events.create({ ... });            // OK
 * await events.update(id, { ... });        // throws 405 APPEND_ONLY_VIOLATION
 * await events.deleteMany({ ... }, { bypassAppendOnly: true }); // audited bypass
 *
 * @example Retention purge (construct with `appendOnlyPlugin({ allowPurge: true })`)
 * events.on('after:append-only-purge', (e) => audit('retention.purge', e));
 * await events.purgeByFilter({ at: { $lt: cutoff } }, { type: 'hard' }, {
 *   retentionPurge: { reason: 'retention: 1095 days', actor: 'job:retention' },
 * });
 */

import { HOOK_PRIORITY } from '@classytic/repo-core/hooks';
import { OP_REGISTRY } from '../operations.js';
import type { Plugin, RepositoryContext, RepositoryInstance } from '../types/repository.js';
import { createError } from '../utils/error.js';
import {
  type RetentionPurgeEvent,
  readRetentionPurge,
  retentionPurgeEvent,
} from './retention-purge.js';

export interface AppendOnlyPluginOptions {
  /**
   * Mutating ops to permit besides `create` / `createMany`. Use for a
   * domain's ONE legitimate mutation path (e.g. GDPR `deleteMany`) —
   * every allowed op still flows through the rest of the plugin stack
   * (tenant scope, audit) as usual.
   */
  allow?: readonly string[] | undefined;
  /**
   * Hook priority for the fence. Default `HOOK_PRIORITY.POLICY` (100).
   * Ledger repos that want the append-only refusal to win over other
   * policy errors (e.g. a missing-tenant throw) register BELOW policy —
   * flow's StockEvent uses `50` so the violation always reads
   * "append-only", never "missing organizationId".
   */
  priority?: number | undefined;
  /**
   * Allow the audited retention purge: `delete` / `deleteMany` with
   * `{ mode: 'hard', retentionPurge: { reason, actor? } }` (and
   * `purgeByFilter` / `purgeByField` with `retentionPurge`) pass the fence,
   * emitting `after:append-only-purge`. Default `false`: the option is
   * refused (403 `RETENTION_PURGE_DISABLED`).
   */
  allowPurge?: boolean | undefined;
  /**
   * Allow `archiveByFilter(filter, sink, { retentionPurge })` to delete the rows its
   * sink acknowledged, and nothing else: a retentionPurge delete without the run's
   * attestation is still refused. Audited via `after:append-only-purge` with
   * `archived: true`. Implied by `allowPurge`. Default `false`.
   */
  allowArchive?: boolean | undefined;
}

/** Payload of `after:append-only-purge`: one per successful purge call. */
export type AppendOnlyPurgeEvent = RetentionPurgeEvent;

const PURGE_OPS = new Set(['delete', 'deleteMany']);

const ALWAYS_ALLOWED = new Set(['create', 'createMany']);

export function appendOnlyPlugin(options: AppendOnlyPluginOptions = {}): Plugin {
  const allowed = new Set([...ALWAYS_ALLOWED, ...(options.allow ?? [])]);

  return {
    name: 'appendOnly',

    apply(repo: RepositoryInstance): void {
      const modelName = (repo as { Model?: { modelName?: string } }).Model?.modelName ?? 'model';
      const purgeGuard = {
        plugin: 'appendOnlyPlugin',
        allowPurge: options.allowPurge === true,
        allowArchive: options.allowArchive === true,
      };
      const priority = options.priority ?? HOOK_PRIORITY.POLICY;

      for (const [op, meta] of Object.entries(OP_REGISTRY)) {
        if (!meta.mutates) continue;
        if (allowed.has(op)) {
          // An allowed delete still validates a purge request, so the audit event is truthful.
          if (PURGE_OPS.has(op)) {
            repo.on(
              `before:${op}`,
              (context: RepositoryContext) => {
                readRetentionPurge(context, op, purgeGuard);
              },
              { priority },
            );
          }
          continue;
        }

        repo.on(
          `before:${op}`,
          (context: RepositoryContext) => {
            // Retention purge: delete-only, reasoned, opt-in (audited after the write).
            if (PURGE_OPS.has(op) && readRetentionPurge(context, op, purgeGuard)) return;
            // Deliberate per-call escape — audited, never silent.
            // (`bypassAppendOnly` is a first-class option — see types.ts.)
            if (context.bypassAppendOnly === true) {
              repo.emit('after:append-only-bypass', { operation: op, context });
              return;
            }
            throw createError(
              405,
              `${modelName} is append-only: '${op}' is not permitted. Rows on this ` +
                `collection are immutable facts (event ledger). Append a compensating ` +
                `row instead; for deliberate maintenance pass bypassAppendOnly: true ` +
                `(audited via 'after:append-only-bypass').`,
              {
                code: 'APPEND_ONLY_VIOLATION',
                meta: { operation: op, model: modelName },
              },
            );
          },
          { priority },
        );
      }

      if (options.allowPurge || options.allowArchive) {
        for (const op of ['delete', 'deleteMany'] as const) {
          // Awaited, not fire-and-forget: the audit is part of the purge. A failing listener
          // fails the call, and one writing with `event.session` joins the delete's transaction.
          repo.on(
            `after:${op}`,
            async (payload: { context: RepositoryContext; result?: unknown }) => {
              const event = retentionPurgeEvent(op, payload.context, payload.result);
              if (event) await repo.emitAsync('after:append-only-purge', event);
            },
          );
        }
      }
    },
  };
}
