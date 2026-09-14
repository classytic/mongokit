/**
 * Deployment-wide pagination policy.
 *
 * ## Why this exists
 *
 * `PaginationConfig` is a per-REPOSITORY setting, supplied as the third
 * constructor argument. That is the right granularity for a repository you
 * build yourself, and the wrong one for a fleet: in a kernel-composed app
 * nobody constructs the repositories. A host wires engines (`defineOrder`,
 * `defineReservation`, `defineParty`, …) and each engine builds its own
 * repositories internally. Unless every one of those kernels grows — and keeps
 * — a passthrough for this config, a host has no way to say "this deployment
 * does not count rows", and inherits `defaultCountStrategy: 'exact'` on every
 * list endpoint it serves.
 *
 * That default is correct for a small app and is the single most expensive one
 * at scale: an offset page costs `countDocuments(filter)` on top of the find,
 * which walks every matching index key. At ten thousand rows per tenant nobody
 * notices. At a million it is the dominant cost of a page the user reads
 * fifteen rows of, and it is paid again on every page.
 *
 * So the policy is settable once, for the process, and every repository built
 * after — or BEFORE — the call picks it up.
 *
 * ## Resolution order
 *
 * Per call  →  per repository  →  this deployment default  →  the library's own.
 *
 * An explicit value always wins. These defaults fill in only where a caller
 * said nothing, so setting them can never override a repository that asked for
 * a specific strategy, and can never override a `countStrategy` passed to one
 * call.
 *
 * ## Why a module-level value and not an injected one
 *
 * It describes the DEPLOYMENT, not the request — the same answer for every
 * tenant, every repository and every query in the process — and injecting it
 * would mean threading it through every kernel, which is the thing this avoids.
 * The cost is that it is global: a test that sets it must reset it, which is
 * what {@link resetPaginationDefaults} is for.
 *
 * @example
 * ```ts
 * // Once, at boot, before composing modules.
 * configurePaginationDefaults({ defaultCountStrategy: 'none' });
 * ```
 */

import type { CountStrategy, PaginationConfig } from '../types/pagination.js';
import type { CursorSecret } from './utils/cursor-signing.js';

/**
 * The subset of {@link PaginationConfig} that describes a deployment rather
 * than one collection's shape.
 *
 * Deliberately NOT `defaultLimit` / `maxLimit` / `cursorVersion`: those are
 * per-collection judgements (a line-item list and an audit log want different
 * page sizes), and a process-wide override of them would be a surprise rather
 * than a policy. What is here is the scale policy — how a page is walked, and
 * whether the rows behind it are counted — plus the one SECURITY setting that
 * is deployment-wide by nature: a signing key is one key for the process, and a
 * repository that quietly declined to use it would be the hole.
 */
export interface PaginationDefaults {
  /** See {@link PaginationConfig.defaultCountStrategy}. */
  defaultCountStrategy?: CountStrategy;
  /**
   * See {@link PaginationConfig.defaultCountLimit}.
   *
   * Belongs to the deployment for the same reason the strategy does: it is the
   * point past which this business stops caring about an exact row count, which
   * is one answer for the whole process, not per collection.
   */
  defaultCountLimit?: number;
  /**
   * See {@link PaginationConfig.cursorSecret}.
   *
   * The reason this one MUST be reachable here: a kernel builds its own
   * repositories, so without the policy seam a host could sign the cursors it
   * mints itself while every engine-owned list kept issuing unsigned ones — a
   * half-signed deployment, which is an unsigned deployment.
   */
  cursorSecret?: CursorSecret;
  /** See {@link PaginationConfig.defaultMode}. */
  defaultMode?: 'offset' | 'keyset';
  /**
   * See {@link PaginationConfig.maxPage}.
   *
   * The other half of the offset cost: `skip(n)` walks n index entries before
   * returning anything, so an unbounded page number is an unbounded read. A
   * fleet that has moved to keyset can lower this to make the offset path's
   * remaining callers fail loudly instead of quietly costing a scan.
   */
  maxPage?: number;
}

/**
 * The policy lives on `globalThis` under a registered symbol, NOT in a module
 * `let`.
 *
 * A module-level binding is per MODULE INSTANCE, and this package can appear
 * twice in one dependency graph — an engine pinning `^3.38` beside a host on
 * `^3.39`, a pnpm layout that duplicates on a peer, an ESM/CJS dual load. The
 * host would call `configurePaginationDefaults` on its copy while the
 * repositories an engine built read the other copy's empty object, and the
 * feature would silently do nothing in EXACTLY the composition it exists for:
 * a host that does not construct its own repositories.
 *
 * `Symbol.for` is the same mechanism, for the same reason, as arc's
 * `Symbol.for('arc.runtimeCapabilities')` / `ARC_EVENT_TRANSPORT`.
 *
 * Per realm, not per process: a `worker_threads` worker has its own
 * `globalThis`, so each worker configures itself at its own boot.
 */
const POLICY_SLOT = Symbol.for('classytic.mongokit.paginationDefaults');

interface PolicyHolder {
  [POLICY_SLOT]?: PaginationDefaults;
}

function policy(): PaginationDefaults {
  const holder = globalThis as PolicyHolder;
  holder[POLICY_SLOT] ??= {};
  return holder[POLICY_SLOT];
}

/**
 * Set the deployment's pagination policy. Merges into whatever is already set,
 * so two call sites configuring different keys do not clobber each other.
 *
 * Call it at boot, before composing modules. Ordering is not load-bearing —
 * repositories read this at query time, not construction time — but a call
 * made after traffic starts changes behaviour mid-flight, which is rarely what
 * anyone means.
 */
export function configurePaginationDefaults(defaults: PaginationDefaults): void {
  Object.assign(policy(), stripUndefined(defaults));
}

/**
 * The current deployment policy. Empty until something configures it.
 *
 * A COPY — `Readonly<T>` is erased at runtime, and handing out the live object
 * would let a caller mutate the policy through a getter that promised not to.
 */
export function getPaginationDefaults(): Readonly<PaginationDefaults> {
  return { ...policy() };
}

/** Back to library defaults. For tests — a global that cannot be reset is a leak between them. */
export function resetPaginationDefaults(): void {
  const current = policy();
  for (const key of Object.keys(current)) {
    delete current[key as keyof PaginationDefaults];
  }
}

/**
 * An explicitly-passed `undefined` means "not specified", not "unset the
 * deployment policy" — `{ defaultMode: undefined }` built from an optional
 * host env var must not silently clear what another call configured.
 */
function stripUndefined(input: PaginationDefaults): PaginationDefaults {
  const out: PaginationDefaults = {};
  if (input.defaultCountStrategy !== undefined)
    out.defaultCountStrategy = input.defaultCountStrategy;
  if (input.defaultCountLimit !== undefined) out.defaultCountLimit = input.defaultCountLimit;
  if (input.cursorSecret !== undefined) out.cursorSecret = input.cursorSecret;
  if (input.defaultMode !== undefined) out.defaultMode = input.defaultMode;
  if (input.maxPage !== undefined) out.maxPage = input.maxPage;
  return out;
}

/**
 * Resolve one repository's config against the deployment policy.
 *
 * Returns an object whose policy keys are GETTERS, so a repository constructed
 * before `configurePaginationDefaults` still answers with the policy — and a
 * test that resets the policy does not have to rebuild its repositories. Keys
 * the repository set explicitly are plain values and never consult the policy.
 */
export function bindPaginationDefaults<T extends object>(resolved: T, config: PaginationConfig): T {
  define(resolved, 'defaultCountStrategy', config.defaultCountStrategy, 'exact');
  define(resolved, 'defaultCountLimit', config.defaultCountLimit, 10_000);
  define(resolved, 'cursorSecret', config.cursorSecret, undefined);
  define(resolved, 'defaultMode', config.defaultMode, undefined);
  define(resolved, 'maxPage', config.maxPage, 10_000);
  return resolved;
}

function define<K extends keyof PaginationDefaults>(
  target: object,
  key: K,
  explicit: PaginationDefaults[K],
  fallback: PaginationDefaults[K],
): void {
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    // Read the policy through `policy()` on EVERY get, never a captured
    // reference: the value may be set after this repository was built, and
    // under a duplicated install the authoritative copy is the shared
    // `globalThis` slot rather than whichever module instance ran this line.
    get: () => (explicit !== undefined ? explicit : (policy()[key] ?? fallback)),
  });
}
