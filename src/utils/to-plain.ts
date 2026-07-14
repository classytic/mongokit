/**
 * Convert a hydrated Mongoose (sub)document to a plain object — the
 * spread-safety primitive for domain verbs that rebuild embedded lines.
 *
 * **The footgun this closes:** spreading a hydrated subdocument
 * (`{ ...line, consumedQuantity: x }`) spreads its Mongoose INTERNAL
 * properties (`$__`, `_doc`, ...), not its schema fields. The rebuilt
 * object then casts to garbage on write — required fields land
 * `undefined`, and because `findOneAndUpdate` does not run validators
 * by default, the corrupt lines persist silently. This has bitten every
 * package that maps over embedded arrays (`components`, `operations`,
 * `revisions`) to produce an updated copy.
 *
 * Rule of thumb: **any `{ ...subdoc }` in a repository verb goes
 * through `toPlain` first.**
 *
 * ```ts
 * const updated = lines.map((line) => ({
 *   ...toPlain(line),
 *   reservedQuantity: reserved.get(line.itemSku) ?? 0,
 * }));
 * ```
 *
 * Non-documents pass through unchanged, so it is safe to apply
 * defensively over values that may or may not be hydrated.
 */
export function toPlain<T>(value: T): T {
  return value !== null &&
    value !== undefined &&
    typeof (value as { toObject?: unknown }).toObject === 'function'
    ? (value as unknown as { toObject(): T }).toObject()
    : value;
}
