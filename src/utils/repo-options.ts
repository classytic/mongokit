import type { SessionOptions } from '../types/operations.js';

/**
 * Forward request-scoped context fields into a mongokit options bag.
 *
 * Multi-tenant scoping, audit attribution, and transaction threading
 * all read their inputs from the **options** argument of every repo
 * method — `multiTenantPlugin` looks for `organizationId`, the audit
 * plugins read `userId` / `user`, and `withTransaction` honors
 * `session`. Consumers were repeatedly hand-rolling:
 *
 *   ```ts
 *   await repo.update(id, data, {
 *     organizationId: ctx.organizationId,
 *     userId: ctx.userId,
 *     session: ctx.session,
 *   });
 *   ```
 *
 * — sometimes correctly forwarding all three, sometimes only one,
 * sometimes constructing `Types.ObjectId(orgId)` manually because the
 * caller didn't trust `multiTenantPlugin` to handle the cast (it does).
 * The result was inconsistent forwarding across repos, with several
 * silent tenant-leak shapes traced back to a forgotten field.
 *
 * `repoOptionsFromCtx(ctx)` is the canonical extractor. Pass it the
 * request context (whatever shape your framework hands you) and it
 * returns the subset of fields mongokit's plugins read. Unknown ctx
 * keys are NOT forwarded — the options bag stays narrow and explicit.
 *
 * @example
 * ```ts
 * import { repoOptionsFromCtx } from '@classytic/mongokit';
 *
 * await orderRepo.update(id, data, repoOptionsFromCtx(ctx));
 * await orderRepo.claim(id, { from: 'pending', to: 'shipped' }, {}, repoOptionsFromCtx(ctx));
 * ```
 *
 * @example Spreading + adding kit-specific options
 * ```ts
 * await orderRepo.findOneAndUpdate(filter, update, {
 *   ...repoOptionsFromCtx(ctx),
 *   returnDocument: 'after',
 *   upsert: true,
 * });
 * ```
 *
 * The fields read (all optional — extracted only when present and not
 * `undefined`):
 *
 * - `organizationId` — multi-tenant scope key. The
 *   `multiTenantPlugin` casts to `ObjectId` automatically when
 *   configured with `fieldType: 'objectId'`; do NOT pre-cast.
 * - `userId` / `user` — audit attribution (audit-log + audit-trail
 *   plugins read these for the `who` column).
 * - `session` — mongoose `ClientSession` for transaction threading.
 * - `requestId` — observability correlation id.
 *
 * Fields beyond this set should be added inline at the call site —
 * `repoOptionsFromCtx` deliberately stays narrow so adding a new
 * convention to the canonical set is a deliberate API decision, not
 * a quiet drift.
 */
export function repoOptionsFromCtx<TCtx extends Record<string, unknown>>(
  ctx: TCtx | undefined | null,
): Record<string, unknown> {
  if (!ctx) return {};
  const out: Record<string, unknown> = {};
  if (ctx.organizationId !== undefined) out.organizationId = ctx.organizationId;
  if (ctx.userId !== undefined) out.userId = ctx.userId;
  if (ctx.user !== undefined) out.user = ctx.user;
  if (ctx.session !== undefined) out.session = ctx.session;
  if (ctx.requestId !== undefined) out.requestId = ctx.requestId;
  return out;
}

/**
 * Build a typed extractor for **consumer-defined** ctx → options
 * forwarding. Same conceptual shape as `repoOptionsFromCtx`, but the
 * caller declares the field set so domain-package fields beyond
 * mongokit's bundled-plugin keys land too.
 *
 * Across the classytic codebase, ~6 packages (commission, supplier-
 * performance, pos, yard, order, plus implicit in leave/payrun/
 * muster/people) ship a hand-rolled 15-line `repo-options.ts` doing
 * the same shape — drift is inevitable, "I forgot to forward
 * `correlationId`" is a recurring bug class. This builder eliminates
 * the boilerplate and pins the field list at the type level so
 * adding a new canonical field is a single-line edit.
 *
 * **Type-safe field declaration.** The `fields` array is constrained
 * to `keyof TCtx & string`, so a typo in a field name is a compile
 * error rather than a silent absent-key. The returned extractor's
 * output keys are inferred from the input field tuple — you can
 * destructure with full autocomplete.
 *
 * **Difference from `repoOptionsFromCtx`.** That helper hardcodes the
 * fields **mongokit's bundled plugins** read (`organizationId`,
 * `userId`, `user`, `session`, `requestId`). Use it when those are
 * sufficient. Reach for `createOptionsExtractor` when your domain has
 * its own canonical fields (`actorRef`, `actorKind`, `correlationId`,
 * `idempotencyKey`, `sagaRunId`, ...) that should also forward.
 *
 * @example Per-package canonical extractor
 * ```ts
 * import { createOptionsExtractor } from '@classytic/mongokit';
 *
 * type CommissionCtx = {
 *   organizationId: string;
 *   actorRef: string;
 *   actorKind: 'user' | 'system';
 *   correlationId: string;
 *   session?: ClientSession;
 *   idempotencyKey?: string;
 * };
 *
 * export const repoOptionsFromCtx = createOptionsExtractor<CommissionCtx>([
 *   'organizationId',
 *   'actorRef',
 *   'actorKind',
 *   'correlationId',
 *   'session',
 *   'idempotencyKey',
 * ]);
 *
 * // Use:
 * await commissionRepo.update(id, data, repoOptionsFromCtx(ctx));
 * ```
 *
 * @param fields - The canonical option keys to extract from ctx.
 *   Must be `(keyof TCtx & string)[]` — TypeScript prevents typos at
 *   the declaration site.
 * @returns An extractor function `(ctx: TCtx | null | undefined) → Record<string, unknown>`
 *   that omits absent/undefined keys (so spreading into a parent
 *   options bag never erases inherited values).
 */
export function createOptionsExtractor<TCtx extends Record<string, unknown>>(
  fields: readonly (keyof TCtx & string)[],
): (ctx: TCtx | undefined | null) => Record<string, unknown> {
  // Freeze a defensive copy so callers can't mutate the field list
  // after extractor creation — which would silently change behaviour
  // of every previously-built extractor sharing the array reference.
  const frozen = Object.freeze([...fields]);
  return function extractRepoOptions(ctx) {
    if (!ctx) return {};
    const out: Record<string, unknown> = {};
    for (const field of frozen) {
      const v = ctx[field];
      if (v !== undefined) out[field] = v;
    }
    return out;
  };
}

/**
 * Canonical options bag for repo calls made OUTSIDE any request scope —
 * event handlers, cron jobs, queue workers, migration scripts.
 *
 * `multiTenantPlugin` requires `organizationId` in the operation
 * context so reads/writes can't leak across tenants from the request
 * layer. Background work has no inherited request scope; calling a
 * tenant-aware repo from an event subscriber without a bypass throws:
 *
 *   "[mongokit] Multi-tenant: Missing 'organizationId' in context for ..."
 *
 * Worse, if the call site is wrapped in `try/catch` (as event handlers
 * routinely are — they fire-and-forget), the error is swallowed and
 * the side effect silently doesn't happen. We've shipped that bug.
 *
 * `systemContext()` returns the canonical opts bag for that case —
 * currently `{ bypassTenant: true }`. The multi-tenant plugin still
 * emits an `after:tenant-bypass` audit event with `reason: 'option'`
 * so observability sees these calls distinct from request-scoped ones.
 *
 * **Greppable on purpose.** A reviewer scanning the codebase can find
 * every "I'm running outside any tenant scope" callsite by searching
 * `systemContext(` — no chasing magic option spreads.
 *
 * **NOT a substitute for proper access control.** Same caveat as raw
 * `bypassTenant`: this bypasses tenant scoping; it does NOT bypass
 * authentication or RBAC. Use only at trusted boundaries — event
 * handlers wired at startup, cron jobs scheduled in code, scripts
 * running with admin credentials.
 *
 * The `extra` overload composes cleanly with transaction sessions and
 * audit-attribution fields; the function's `bypassTenant: true` is
 * applied last so it cannot be accidentally overridden.
 *
 * @example Event handler
 * ```ts
 * import { systemContext } from '@classytic/mongokit';
 *
 * order.events.subscribe('order:completed', async (event) => {
 *   const matches = await enrollmentRepo.aggregatePipeline(
 *     [{ $match: { orderId: event.payload.orderId, status: 'active' } }],
 *     systemContext(),
 *   );
 *   for (const m of matches) {
 *     await enrollmentRepo.update(m._id, { status: 'fulfilled' }, systemContext());
 *   }
 * });
 * ```
 *
 * @example Composed with a transaction
 * ```ts
 * await withTransaction(conn, async (session) => {
 *   await enrollmentRepo.update(id, data, systemContext({ session }));
 *   await auditRepo.create(entry, systemContext({ session }));
 * });
 * ```
 *
 * @example Cron / scheduled cleanup
 * ```ts
 * for await (const doc of repo.cursor(
 *   { expiresAt: { $lt: new Date() } },
 *   systemContext(),
 * )) {
 *   await repo.delete(doc._id, systemContext());
 * }
 * ```
 *
 * @param extra - Optional extra options to merge in (e.g. `session`
 *   for transactions, `userId` for audit attribution). Any
 *   `bypassTenant` value here is overridden — the function name is
 *   load-bearing.
 * @returns A `SessionOptions` object with `bypassTenant: true` set.
 */
export function systemContext(extra?: SessionOptions): SessionOptions {
  return { ...extra, bypassTenant: true };
}
