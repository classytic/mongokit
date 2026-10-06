/**
 * Compare DECLARED indexes against what a database actually has.
 *
 * `unique: true` on a schema is a correctness constraint only if the index was
 * built. A skipped deploy step is otherwise SILENT — one deployment ran with
 * 401 declared indexes absent, accumulated duplicate rows on a "unique" field,
 * and nothing anywhere said the constraint did not exist. mongokit owns the
 * declaration, so it owns the means to check it.
 *
 * Read-only. It NEVER builds: index builds belong to a deploy step, not to a
 * serving process.
 *
 * Missing UNIQUE indexes are reported separately from missing regular ones —
 * the first silently admits duplicate data, the second only costs a scan.
 *
 * Same keys are not the same index: a live index is compared on the options that decide
 * correctness (`unique`, `partialFilterExpression`, `sparse`, `collation`, `expireAfterSeconds`).
 * A same-key index that differs is reported as `incompatible` — its fix is a rebuild, not a create.
 *
 * DELIBERATELY ONE-DIRECTIONAL: an index present in the database but absent
 * from a schema is NOT drift. Auth libraries and migrations manage indexes
 * outside the ODM, and treating those as removable is exactly what makes a
 * `syncIndexes()` unsafe.
 *
 * Sibling of `query/primitives/indexes`, which reads DECLARATIONS only and
 * touches no connection. This module is the live comparison.
 */

/** The slice of a Mongoose-like connection this needs. Structural on purpose. */
export interface IndexVerifiableConnection {
  modelNames(): string[];
  model(name: string): IndexVerifiableModel;
}

export interface IndexVerifiableModel {
  schema: { indexes(): Array<[Record<string, unknown>, Record<string, unknown>?]> };
  collection: {
    name: string;
    listIndexes(): { toArray(): Promise<Array<Record<string, unknown>>> };
  };
}

export interface MissingIndex {
  model: string;
  collection: string;
  /** The declared key, JSON-stringified — stable to log and to diff. */
  key: string;
}

/** A live index on the declared keys whose correctness options differ from the declaration. */
export interface IncompatibleIndex extends MissingIndex {
  /** Declared `unique` — a mismatch here can already have admitted duplicates. */
  unique: boolean;
  /** One line per differing option: `unique: declared true, live false`. */
  differences: string[];
}

export interface IndexVerifyReport {
  modelsChecked: number;
  /** Declared `unique` indexes with nothing behind them. Duplicates can already exist. */
  missingUnique: MissingIndex[];
  missingRegular: MissingIndex[];
  /** Same keys, different semantics — e.g. declared unique, built non-unique. */
  incompatible: IncompatibleIndex[];
  /** Models whose indexes could not be read — collection absent, or no permission. */
  unreadable: string[];
}

export interface VerifyIndexesOptions {
  /**
   * Include a model in the sweep. Default: every model.
   *
   * A kernel that materialises different model sets per mode must skip exactly
   * the set its deploy step skips — indexing a model CREATES its collection, so
   * a mismatch here reports permanent phantom drift instead of a real gap.
   */
  includeModel?: (modelName: string) => boolean;
}

/**
 * Order-sensitive: a compound index is not the same index with keys swapped.
 *
 * A SINGLE-field numeric index is direction-agnostic though — mongo traverses
 * an index either way, so `{t:1}` and `{t:-1}` are the same index and a schema
 * declaring one against a database holding the other is not drift. Only numeric
 * directions collapse; `2dsphere` / `hashed` are index TYPES, not directions.
 */
function normalizeKey(key: Record<string, unknown>): string {
  const entries = Object.entries(key);
  if (entries.length === 1 && typeof entries[0]?.[1] === 'number') {
    return JSON.stringify([[entries[0][0]]]);
  }
  return JSON.stringify(entries);
}

/**
 * A TEXT index is stored under a key mongo invents (`{_fts, _ftsx}`) with the
 * real fields moved to `weights`, so it never matches its own declaration by
 * key. Compare the field SET instead, or every text index reads as permanently
 * missing and the whole check becomes noise nobody reads.
 */
function textFields(key: Record<string, unknown>): string[] | null {
  const fields = Object.entries(key)
    .filter(([, dir]) => dir === 'text')
    .map(([field]) => field);
  return fields.length > 0 ? fields.sort() : null;
}

/** Order-free JSON, so `{a:1,b:2}` equals `{b:2,a:1}` — option objects are not order-sensitive. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/**
 * The options that change what an index GUARANTEES, compared declared → live. Absent means
 * off (`unique`, `sparse`) or none (`partialFilterExpression`, `expireAfterSeconds`). A collation
 * is compared on the DECLARED fields only: the server fills in every default it does not store.
 */
function optionDifferences(
  declared: Record<string, unknown>,
  live: Record<string, unknown>,
): string[] {
  const diffs: string[] = [];
  const flag = (name: string) => {
    const d = declared[name] === true;
    const l = live[name] === true;
    if (d !== l) diffs.push(`${name}: declared ${d}, live ${l}`);
  };
  flag('unique');
  flag('sparse');
  for (const name of ['partialFilterExpression', 'expireAfterSeconds'] as const) {
    const d = declared[name] === undefined ? 'none' : canonical(declared[name]);
    const l = live[name] === undefined ? 'none' : canonical(live[name]);
    if (d !== l) diffs.push(`${name}: declared ${d}, live ${l}`);
  }
  const dColl = declared.collation as Record<string, unknown> | undefined;
  const lColl = live.collation as Record<string, unknown> | undefined;
  if (dColl) {
    const mismatch = Object.keys(dColl).filter(
      (k) => canonical(dColl[k]) !== canonical(lColl?.[k]),
    );
    if (mismatch.length > 0)
      diffs.push(
        `collation: declared ${canonical(dColl)}, live ${lColl ? canonical(lColl) : 'none'}`,
      );
  } else if (lColl && lColl.locale !== 'simple') {
    diffs.push(`collation: declared none, live ${canonical(lColl)}`);
  }
  return diffs;
}

export async function verifyIndexes(
  connection: IndexVerifiableConnection,
  options: VerifyIndexesOptions = {},
): Promise<IndexVerifyReport> {
  const include = options.includeModel ?? (() => true);
  const report: IndexVerifyReport = {
    modelsChecked: 0,
    missingUnique: [],
    missingRegular: [],
    incompatible: [],
    unreadable: [],
  };

  for (const name of connection.modelNames().sort()) {
    if (!include(name)) continue;

    const model = connection.model(name);
    const declared = model.schema.indexes();
    if (declared.length === 0) continue;

    // Several live indexes may share keys (different collation / partial filter), so keep them all.
    let existing: Map<string, Array<Record<string, unknown>>>;
    let existingText: Map<string, Array<Record<string, unknown>>>;
    try {
      const live = await model.collection.listIndexes().toArray();
      existing = new Map();
      existingText = new Map();
      for (const index of live) {
        const byKey = index.weights
          ? ([existingText, JSON.stringify(Object.keys(index.weights as object).sort())] as const)
          : ([existing, normalizeKey(index.key as Record<string, unknown>)] as const);
        const [map, k] = byKey;
        map.set(k, [...(map.get(k) ?? []), index]);
      }
    } catch {
      // Collection not created yet — its declared indexes ARE missing, but that
      // is indistinguishable from an empty deployment, so report it separately
      // rather than as drift somebody has to chase.
      report.unreadable.push(name);
      continue;
    }

    report.modelsChecked += 1;

    for (const [key, indexOptions] of declared) {
      const asText = textFields(key);
      const sameKey = asText
        ? existingText.get(JSON.stringify(asText))
        : existing.get(normalizeKey(key));
      const entry: MissingIndex = {
        model: name,
        collection: model.collection.name,
        key: JSON.stringify(key),
      };
      const opts = (indexOptions ?? {}) as Record<string, unknown>;
      if (sameKey && sameKey.length > 0) {
        const diffsPerCandidate = sameKey.map((live) => optionDifferences(opts, live));
        if (diffsPerCandidate.some((d) => d.length === 0)) continue;
        report.incompatible.push({
          ...entry,
          unique: opts.unique === true,
          differences: diffsPerCandidate[0] ?? [],
        });
        continue;
      }
      if (opts.unique === true) {
        report.missingUnique.push(entry);
      } else {
        report.missingRegular.push(entry);
      }
    }
  }

  return report;
}

/** One-line summary for a boot log. */
export function formatIndexReport(report: IndexVerifyReport): string {
  const parts = [
    `${report.modelsChecked} models checked`,
    `missing unique: ${report.missingUnique.length}`,
    `missing regular: ${report.missingRegular.length}`,
    `incompatible: ${report.incompatible.length}`,
  ];
  if (report.unreadable.length > 0) parts.push(`unreadable: ${report.unreadable.length}`);
  return `[index-check] ${parts.join(' — ')}`;
}
