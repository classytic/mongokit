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

export interface IndexVerifyReport {
  modelsChecked: number;
  /** Declared `unique` indexes with nothing behind them. Duplicates can already exist. */
  missingUnique: MissingIndex[];
  missingRegular: MissingIndex[];
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

export async function verifyIndexes(
  connection: IndexVerifiableConnection,
  options: VerifyIndexesOptions = {},
): Promise<IndexVerifyReport> {
  const include = options.includeModel ?? (() => true);
  const report: IndexVerifyReport = {
    modelsChecked: 0,
    missingUnique: [],
    missingRegular: [],
    unreadable: [],
  };

  for (const name of connection.modelNames().sort()) {
    if (!include(name)) continue;

    const model = connection.model(name);
    const declared = model.schema.indexes();
    if (declared.length === 0) continue;

    let existing: Set<string>;
    let existingText: Set<string>;
    try {
      const live = await model.collection.listIndexes().toArray();
      existing = new Set(live.map((i) => normalizeKey(i.key as Record<string, unknown>)));
      existingText = new Set(
        live
          .filter((i) => i.weights)
          .map((i) => JSON.stringify(Object.keys(i.weights as object).sort())),
      );
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
      if (asText) {
        if (existingText.has(JSON.stringify(asText))) continue;
      } else if (existing.has(normalizeKey(key))) {
        continue;
      }
      const entry: MissingIndex = {
        model: name,
        collection: model.collection.name,
        key: JSON.stringify(key),
      };
      if ((indexOptions as { unique?: boolean } | undefined)?.unique) {
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
  ];
  if (report.unreadable.length > 0) parts.push(`unreadable: ${report.unreadable.length}`);
  return `[index-check] ${parts.join(' — ')}`;
}
