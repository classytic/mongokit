/**
 * Immutable-States Plugin
 *
 * Lifecycle immutability: documents FREEZE when they reach one of the
 * configured states ("posted journal entries are audit records", "paid
 * invoices don't change", "activated BOM revisions are pinned"). The
 * generalized form of ledger's battle-tested `immutableGuardPlugin`,
 * promoted so every package with a posted/approved/activated lifecycle
 * shares one enforcement layer instead of hand-rolling hook subsets.
 *
 * DISTINCT from `appendOnlyPlugin` — never merge them:
 *   - `appendOnlyPlugin`: the whole COLLECTION is immutable facts.
 *     Zero-IO blanket refusal.
 *   - `immutableStatesPlugin`: rows are editable until a STATE freezes
 *     them; legal exits ride `claim` CAS transitions. State-aware, so
 *     some paths cost a lookup.
 *
 * Per-op strategy (why each op is handled the way it is):
 *   - `update` / `delete` / `claimVersion` / `restore` (id-shaped):
 *     read the target's state (raw Model — never re-enters the hook
 *     pipeline); frozen → refuse.
 *   - `findOneAndUpdate` (query-shaped, single doc): pre-read with the
 *     caller's filter; a frozen match → refuse.
 *   - `updateMany` / `deleteMany` (query-shaped, multi): `exists()`
 *     probe of `{ ...filter, [field]: { $in: states } }` — refuse when
 *     ANY frozen row is in the blast radius. Deliberately NOT a silent
 *     `$nin` filter injection: silently skipping frozen rows would
 *     report success while lying about coverage.
 *   - `bulkUpsert`: an `exists()` probe over the sub-op filters; any frozen target refuses.
 *   - `bulkWrite`: heterogeneous op arrays can't be analyzed reliably —
 *     refused outright unless internal-flagged.
 *   - `claim`: zero-IO when the claim targets the SAME field — the CAS
 *     `from` pins the pre-state, so `from` outside the frozen set can't
 *     touch a frozen row by construction. `from` including a frozen
 *     state → refused unless `allowClaim` exempts the shape (e.g.
 *     ledger's reverse-mark stamp). A claim on a DIFFERENT field does
 *     NOT pin this plugin's state, so it falls back to the id lookup —
 *     closing a hole the hand-rolled ledger guard had (a
 *     `claim(id, { field: 'phase', ... }, { $set: {...} })` could
 *     mutate a posted entry unguarded).
 *
 * **Race semantics (honest, rule 33):** the lookups are defense-in-depth
 * against DIRECT mutation of frozen rows, not a concurrency mechanism —
 * a read-then-write guard cannot close TOCTOU. Legal state transitions
 * must ride `claim`/`transition()` CAS (which pins the from-state at the
 * database); this plugin exists to stop the paths that would skip that
 * discipline entirely.
 *
 * **Escape model:** `internalFlag` is a PRIVATE engine handshake — the
 * engine's own verbs (post/unpost/reverse/archive) set it; public
 * callers have no documented way to. This is deliberately NOT the
 * audited public `bypassAppendOnly` model: lifecycle engines need their
 * transition verbs to work, hosts never need to bypass.
 *
 * **Retention purge (`allowPurge`):** the one public way to remove frozen
 * rows (shared with `appendOnlyPlugin`, see `./retention-purge.ts`). Opt in
 * at construction (`allowPurge: true`), then pass
 * `retentionPurge: { reason, actor? }` with `mode: 'hard'` on `delete` /
 * `deleteMany`, or run `purgeByFilter(filter, { type: 'hard' },
 * { retentionPurge })`, which forwards it to every chunk. The frozen guard is lifted for THAT call only; every other
 * op (and every delete without the option) stays refused. A purge without
 * `allowPurge`, without a non-blank `reason`, or without `mode: 'hard'` is
 * refused. Each successful purge emits `after:immutable-states-purge`
 * ({@link ImmutablePurgeEvent}) with the reason, actor, target and
 * `deletedCount`, so a retention job's audit row rides the repository it
 * already uses instead of a second, unguarded one. Purge is DELETE-only:
 * frozen rows are never editable through it.
 *
 * **Future-proofing:** at apply time the plugin sweeps `OP_REGISTRY`
 * and THROWS if a mutating op exists that it has no strategy for — a
 * new mongokit write op can never silently ship unfenced (the exact
 * failure mode that left `findOneAndUpdate`/`updateMany`/`bulkWrite`
 * unguarded in the hand-rolled predecessor).
 *
 * @example Retention purge of closed records
 * const repo = new Repository(OccurrenceModel, [
 *   immutableStatesPlugin({ states: ['CLOSED'], allowPurge: true }),
 * ]);
 * repo.on('after:immutable-states-purge', (e) => audit('retention.purge', e));
 * await repo.deleteMany(
 *   { status: 'CLOSED', endedAt: { $lt: cutoff } },
 *   { mode: 'hard', retentionPurge: { reason: 'retention: 7 years', actor: 'job:retention' } },
 * );
 *
 * @example Ledger (posted journal entries)
 * const jeRepo = new Repository(JEModel, [
 *   immutableStatesPlugin({
 *     states: ['posted'],
 *     field: 'state',
 *     internalFlag: '_ledgerInternal',
 *     tenantField: 'organizationId',
 *     allowClaim: isReverseMarkClaim,
 *     errorFactory: ({ id }) => new ImmutableViolationError(id),
 *   }),
 * ]);
 */

import type { ClientSession, Model } from 'mongoose';
import { OP_REGISTRY } from '../operations.js';
import type { Plugin, RepositoryContext, RepositoryInstance } from '../types/repository.js';
import { createError } from '../utils/error.js';
import {
  type RetentionPurgeEvent,
  type RetentionPurgeRequest,
  readRetentionPurge,
  retentionPurgeEvent,
} from './retention-purge.js';

/** The slice of a `before:claim` context `allowClaim` predicates see. */
export interface ImmutableClaimView {
  id: unknown;
  transition: {
    from?: unknown | readonly unknown[];
    to?: unknown;
    field?: string;
    where?: Record<string, unknown>;
  };
  /** Operator-form patch (`{ $set: {...}, ... }`). */
  data: Record<string, unknown> | undefined;
}

export interface ImmutableStatesPluginOptions {
  /** States in which the document is frozen (e.g. `['posted']`). */
  states: readonly string[];
  /** State field on the doc — dotted paths supported. Default `'state'`. */
  field?: string | undefined;
  /**
   * Context flag the OWNING ENGINE's verbs set to pass the guard
   * (private handshake — see module doc). Default `'_immutableInternal'`.
   */
  internalFlag?: string | undefined;
  /** Tenant field used to scope state lookups (mirrors the repo's scope). */
  tenantField?: string | undefined;
  /**
   * Exempt specific claim shapes that legitimately touch frozen rows
   * (audit-trail stamps like ledger's reverse-mark). Return `true` to
   * allow. Runs only after the claim was determined to reach a frozen
   * state — keep the predicate a strict fingerprint.
   */
  allowClaim?: ((view: ImmutableClaimView) => boolean) | undefined;
  /**
   * Allow the audited retention purge: `delete` / `deleteMany` with
   * `{ mode: 'hard', retentionPurge: { reason, actor? } }` (and
   * `purgeByFilter` / `purgeByField` with `retentionPurge`) may remove frozen
   * rows, emitting `after:immutable-states-purge`. Default `false`: the
   * option is refused (403 `RETENTION_PURGE_DISABLED`).
   */
  allowPurge?: boolean | undefined;
  /** Domain error to throw. Default: 403 `IMMUTABLE_STATE_VIOLATION`. */
  errorFactory?:
    | ((ctx: { id: unknown; operation: string; state?: string | undefined }) => Error)
    | undefined;
}

/** Per-call purge request (`options.retentionPurge`). */
export type ImmutablePurgeRequest = RetentionPurgeRequest;

/** Payload of `after:immutable-states-purge`: one per successful purge call. */
export interface ImmutablePurgeEvent extends RetentionPurgeEvent {
  /** The frozen states configured on the plugin. */
  states: readonly string[];
}

type Ctx = RepositoryContext & {
  id?: unknown;
  query?: Record<string, unknown>;
  data?: Record<string, unknown>;
  transition?: ImmutableClaimView['transition'];
};

/** Ops this plugin has an explicit strategy for (see module doc). */
const STRATEGY_OPS = new Set([
  'create',
  'createMany', // inserts can't touch existing rows — allowed
  'update',
  'delete',
  'claimVersion',
  'restore',
  'findOneAndUpdate',
  'updateMany',
  'deleteMany',
  'bulkWrite',
  'bulkUpsert',
  'claim',
]);

export function immutableStatesPlugin(options: ImmutableStatesPluginOptions): Plugin {
  const field = options.field ?? 'state';
  const internalFlag = options.internalFlag ?? '_immutableInternal';
  const frozen = new Set(options.states);
  const throwViolation = (ctx: { id: unknown; operation: string; state?: string | undefined }) => {
    if (options.errorFactory) throw options.errorFactory(ctx);
    throw createError(
      403,
      `Document ${String(ctx.id)} is in immutable state` +
        `${ctx.state !== undefined ? ` '${ctx.state}'` : ''} — '${ctx.operation}' is not ` +
        `permitted. Frozen rows change only through the owning engine's transition verbs.`,
      { code: 'IMMUTABLE_STATE_VIOLATION', meta: { ...ctx } },
    );
  };

  return {
    name: 'immutableStates',

    apply(repo: RepositoryInstance): void {
      // Boot-time sweep — a mutating op with no strategy is a loud
      // failure, never a silent gap (the predecessor's failure mode).
      const unhandled = Object.entries(OP_REGISTRY)
        .filter(([op, meta]) => meta.mutates && !STRATEGY_OPS.has(op))
        .map(([op]) => op);
      if (unhandled.length > 0) {
        throw createError(
          500,
          `immutableStatesPlugin has no strategy for mutating op(s): ${unhandled.join(', ')}. ` +
            'Mongokit added write ops this plugin predates — extend the plugin before using it.',
          { code: 'IMMUTABLE_STATES_UNHANDLED_OPS', meta: { unhandled } },
        );
      }

      const Model = (repo as unknown as { Model: Model<unknown> }).Model;
      const getState = (doc: unknown): string | undefined =>
        field
          .split('.')
          .reduce<unknown>(
            (acc, key) => (acc as Record<string, unknown> | undefined)?.[key],
            doc,
          ) as string | undefined;

      const scoped = (base: Record<string, unknown>, ctx: Ctx): Record<string, unknown> => {
        const q = { ...base };
        if (options.tenantField && ctx.query && options.tenantField in ctx.query) {
          q[options.tenantField] = ctx.query[options.tenantField];
        }
        return q;
      };

      /** The call's session: every guard read runs in it, so a row frozen earlier in the same transaction counts. */
      const sessionOf = (ctx: Ctx) => (ctx.session ?? null) as ClientSession | null;

      /** Raw-Model read — never re-enters the repo hook pipeline. */
      const readStateById = async (ctx: Ctx): Promise<string | undefined> => {
        if (ctx.id === undefined || ctx.id === null) return undefined;
        const doc = await Model.findOne(scoped({ _id: ctx.id }, ctx))
          .select({ [field]: 1 })
          .session(sessionOf(ctx))
          .lean();
        return doc ? getState(doc) : undefined;
      };

      const guardById = (op: string) => async (ctx: Ctx) => {
        if (ctx[internalFlag]) return;
        const state = await readStateById(ctx);
        if (state !== undefined && frozen.has(state)) {
          throwViolation({ id: ctx.id, operation: op, state });
        }
      };

      const purgeGuard = {
        plugin: 'immutableStatesPlugin',
        allowPurge: options.allowPurge === true,
      };
      const purgeRequest = (op: string, ctx: Ctx) => readRetentionPurge(ctx, op, purgeGuard);

      for (const op of ['update', 'claimVersion', 'restore'] as const) {
        repo.on(`before:${op}`, guardById(op));
      }
      const guardDelete = guardById('delete');
      repo.on('before:delete', async (ctx: Ctx) => {
        if (ctx[internalFlag]) return;
        if (purgeRequest('delete', ctx)) return;
        await guardDelete(ctx);
      });

      // Audit: one event per successful purge, with what it actually removed. Awaited, not
      // fire-and-forget: a failing listener fails the call, and one writing with
      // `event.session` joins the delete's transaction.
      const emitPurge = async (
        operation: ImmutablePurgeEvent['operation'],
        context: Ctx,
        result: unknown,
      ): Promise<void> => {
        if (!options.allowPurge || context[internalFlag]) return;
        const base = retentionPurgeEvent(operation, context, result);
        if (!base) return;
        const event: ImmutablePurgeEvent = { ...base, states: [...frozen] };
        await repo.emitAsync('after:immutable-states-purge', event);
      };
      repo.on('after:delete', (payload: { context: Ctx; result?: unknown }) =>
        emitPurge('delete', payload.context, payload.result),
      );
      repo.on('after:deleteMany', (payload: { context: Ctx; result?: unknown }) =>
        emitPurge('deleteMany', payload.context, payload.result),
      );

      // findOneAndUpdate — single-doc, query-shaped: pre-read the match.
      repo.on('before:findOneAndUpdate', async (ctx: Ctx) => {
        if (ctx[internalFlag]) return;
        const filter = ctx.query ?? {};
        const doc = await Model.findOne(filter)
          .select({ [field]: 1, _id: 1 })
          .session(sessionOf(ctx))
          .lean();
        if (!doc) return;
        const state = getState(doc);
        if (state !== undefined && frozen.has(state)) {
          throwViolation({
            id: (doc as { _id?: unknown })._id,
            operation: 'findOneAndUpdate',
            state,
          });
        }
      });

      // updateMany / deleteMany — refuse when ANY frozen row matches.
      const guardMany = (op: string) => async (ctx: Ctx) => {
        if (ctx[internalFlag]) return;
        const filter = ctx.query ?? {};
        // $and-merge — spreading would OVERRIDE a caller's own predicate
        // on the state field (e.g. `{ state: 'draft' }`) and false-refuse
        // legitimate non-frozen batches.
        const hit = await Model.exists({
          $and: [filter, { [field]: { $in: [...frozen] } }],
        }).session(sessionOf(ctx));
        if (hit) {
          throwViolation({ id: hit._id, operation: op, state: undefined });
        }
      };
      repo.on('before:updateMany', guardMany('updateMany'));
      const guardDeleteMany = guardMany('deleteMany');
      repo.on('before:deleteMany', async (ctx: Ctx) => {
        if (ctx[internalFlag]) return;
        if (purgeRequest('deleteMany', ctx)) return;
        await guardDeleteMany(ctx);
      });

      // bulkUpsert — homogeneous keyed sub-ops: refuse when ANY targeted row is frozen (as
      // updateMany), never skip it silently. Read in the call's session so a row frozen earlier in
      // the same transaction counts.
      repo.on('before:bulkUpsert', async (ctx: Ctx) => {
        if (ctx[internalFlag]) return;
        const ops = (ctx.operations ?? []) as Array<{
          updateOne?: { filter?: Record<string, unknown> };
        }>;
        const filters = ops.flatMap((op) => (op.updateOne?.filter ? [op.updateOne.filter] : []));
        if (filters.length === 0) return;
        const hit = await Model.exists({
          $and: [{ $or: filters }, { [field]: { $in: [...frozen] } }],
        }).session((ctx.session ?? null) as ClientSession | null);
        if (hit) throwViolation({ id: hit._id, operation: 'bulkUpsert', state: undefined });
      });

      // bulkWrite — heterogeneous; refuse unless internal-flagged.
      repo.on('before:bulkWrite', (ctx: Ctx) => {
        if (ctx[internalFlag]) return;
        throwViolation({ id: undefined, operation: 'bulkWrite', state: undefined });
      });

      // claim — the transition mechanism itself. Same-field claims are
      // analyzed zero-IO via the CAS `from`; different-field claims
      // fall back to the id lookup (they don't pin our state).
      repo.on('before:claim', async (rawCtx: RepositoryContext) => {
        const ctx = rawCtx as Ctx;
        if (ctx[internalFlag]) return;
        const t = ctx.transition;
        if (!t) return;
        const claimField = t.field ?? 'status';

        if (claimField === field) {
          const fromSpec = t.from;
          const touchesFrozen = Array.isArray(fromSpec)
            ? fromSpec.some((f) => frozen.has(String(f)))
            : frozen.has(String(fromSpec));
          if (!touchesFrozen) return; // CAS pins a non-frozen pre-state.
          if (
            options.allowClaim?.({
              id: ctx.id,
              transition: t,
              data: ctx.data,
            })
          ) {
            return;
          }
          throwViolation({ id: ctx.id, operation: 'claim', state: undefined });
        }

        // Different-field claim: the CAS doesn't constrain OUR state.
        const state = await readStateById(ctx);
        if (state !== undefined && frozen.has(state)) {
          if (options.allowClaim?.({ id: ctx.id, transition: t, data: ctx.data })) {
            return;
          }
          throwViolation({ id: ctx.id, operation: 'claim', state });
        }
      });
    },
  };
}
