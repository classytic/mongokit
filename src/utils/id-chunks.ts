/**
 * Shared id-set primitives for BOTH of mongokit's chunking idioms.
 *
 * mongokit has two standards for touching an unbounded matching set, and they are not
 * interchangeable:
 *
 * 1. **Progressive strategy application** — `runChunkedPurge` / `runChunkedArchive`
 *    (repo-core) over the keyset ports in `../actions/purge.ts` / `../actions/archive.ts`.
 *    The set is processed chunk by chunk and NOTHING is held across chunks. Use it when
 *    the operation is "apply this write to everything matching", e.g. tenant purge,
 *    retention sweeps, `cascadePurgeReferences`. Its shared shapes live here:
 *    {@link keysetFilter} (the `_id > cursor` progression), {@link selectKeysetChunk}
 *    (the `_id`-ascending bounded select), {@link narrowToIds} (the re-asserted write).
 *
 * 2. **Snapshot-then-act** — {@link collectIds} + {@link idChunks}. A hook sandwich
 *    (`before:deleteMany` snapshots, the repo executes ONE `deleteMany`,
 *    `after:deleteMany` acts on the snapshot) cannot progress a keyset across the parent
 *    write: the ids must be captured in full BEFORE the parent rows disappear, and
 *    consumed AFTER. The array is therefore inherently O(matched); what these helpers
 *    bound is everything else — the collection round-trip materializes bare ids via a
 *    driver cursor (no lean-doc array doubling the peak), and every downstream `$in` is
 *    sliced so no single query document grows with the match size (Mongo rejects query
 *    documents past 16 MB, which an unsliced `$in` reaches at roughly a million
 *    ObjectIds).
 *
 * (`../pagination/utils/cursor.ts` is API cursor ENCODING for paginated reads — a third,
 * unrelated concern; do not reach for it here.)
 */
import type { ClientSession, Model } from 'mongoose';

/**
 * Default slice for `$in` fan-out. Larger than `runChunkedPurge`'s 1000 on purpose:
 * a purge chunk bounds the WRITE LOCK SCOPE of each progressive strategy step, while a
 * snapshot slice bounds only the query-document size and the per-call working set —
 * 10k ObjectIds is ~120 KB of `$in`, far under every limit, at 10× fewer round trips.
 */
export const DEFAULT_ID_CHUNK = 10_000;

/**
 * Collect the bare id values matching `filter`, streaming via a driver cursor so the
 * only O(n) allocation is the returned array itself (a `find().lean()` materializes an
 * intermediate array of `{_id}` documents first — roughly double the peak for large n).
 */
export async function collectIds(
  model: Model<unknown>,
  filter: Record<string, unknown>,
  options: { session?: ClientSession | undefined; idField?: string } = {},
): Promise<unknown[]> {
  const idField = options.idField ?? '_id';
  const ids: unknown[] = [];
  const cursor = model
    .find(filter, { [idField]: 1 })
    .session(options.session ?? null)
    .lean()
    .cursor();
  for await (const doc of cursor) {
    ids.push((doc as Record<string, unknown>)[idField]);
  }
  return ids;
}

/**
 * Yield `ids` in consecutive slices of at most `size`. Yields nothing for an empty
 * array. `size` must be a positive integer — sliced `$in` correctness depends on it,
 * so a nonsense size throws instead of silently degrading to one giant slice.
 */
export function* idChunks<T>(ids: readonly T[], size: number): Generator<T[], void, undefined> {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`idChunks: size must be a positive integer, got ${String(size)}`);
  }
  for (let i = 0; i < ids.length; i += size) {
    yield ids.slice(i, i + size) as T[];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Keyset primitives — the progressive idiom's shared shapes
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compose the keyset-progressed select filter: the base predicate, narrowed to rows past
 * the last committed `_id`. `cursor == null` means "from the start". Selection paired
 * with this must sort `_id`-ascending ({@link selectKeysetChunk} does), so `$gt: cursor`
 * never revisits a processed row and never skips an unprocessed one. Never mutates
 * `baseFilter`.
 */
export function keysetFilter(
  baseFilter: Record<string, unknown>,
  cursor: unknown,
): Record<string, unknown> {
  return cursor == null ? baseFilter : { ...baseFilter, _id: { $gt: cursor } };
}

/**
 * The `_id`-ascending bounded chunk select both action ports share:
 * `find(filter).sort({_id: 1}).limit(limit).lean()`. Lean on purpose — chunk consumers
 * want plain objects, not hydrated documents. Pass `projection: {_id: 1}` when only ids
 * are needed (the purge port's common path); omit it for full docs (archive's readChunk,
 * anonymize-functional).
 */
export async function selectKeysetChunk<T>(
  model: Model<T>,
  filter: Record<string, unknown>,
  limit: number,
  options: {
    session?: ClientSession | undefined;
    projection?: Record<string, 1 | 0> | undefined;
  } = {},
): Promise<T[]> {
  return (await model
    .find(filter, options.projection)
    .sort({ _id: 1 })
    .limit(limit)
    .session(options.session ?? null)
    .lean()
    .exec()) as T[];
}

/**
 * Re-assert the base predicate on an id-narrowed WRITE: `{...base, _id: {$in: ids}}`.
 * The `$in` alone would be enough to address the chunk, but carrying the base predicate
 * defends against a row whose scope fields changed between the chunk select and the
 * write — such a row is silently skipped instead of written outside its cohort. Both
 * action ports use this shape; use it for any select-then-write over a chunk.
 */
export function narrowToIds(
  baseFilter: Record<string, unknown>,
  ids: readonly unknown[],
): Record<string, unknown> {
  return { ...baseFilter, _id: { $in: ids } };
}
