/**
 * `AggDateBucket` → MongoDB `$dateToString` / `$concat` /
 * `$dateTrunc` expression.
 *
 * Two surface forms — both compile to canonical ISO-shaped strings
 * identical to sqlitekit's output, so cross-kit `AggRow` shape stays
 * stable:
 *
 * **Named buckets** (`'minute' | 'hour' | 'day' | 'week' | 'month' |
 * 'quarter' | 'year'`) emit `$dateToString` with a fixed format string.
 *
 * **Custom bins** (`{ every: N, unit }`) emit `$dateTrunc` (Mongo 5+)
 * to truncate to the bin start, then `$dateToString` to canonicalise
 * the label. The combination of the two operators gives precise
 * arbitrary-interval bucketing without driver math.
 *
 * Format-by-interval matrix (label shape → unit):
 *   - `minute`  → `'YYYY-MM-DDTHH:MM'`
 *   - `hour`    → `'YYYY-MM-DDTHH:00'`
 *   - `day`     → `'YYYY-MM-DD'`
 *   - `week`    → `'YYYY-Www'`     (ISO 8601 week-numbering year + week)
 *   - `month`   → `'YYYY-MM'`
 *   - `quarter` → `'YYYY-Qn'`      (synthesised via `$concat`)
 *   - `year`    → `'YYYY'`
 *
 * The source field is wrapped in `$toDate` so callers may store
 * timestamps as strings (ISO-8601), numbers (epoch ms), or native
 * BSON Date — every shape parses to the same canonical bucket label.
 *
 * **Bucketing honours `AggDateBucket.timezone`, defaulting to UTC** — see the IR contract in
 * repo-core's `AggDateBucketInterval`.
 */

import type { AggDateBucket, AggDateBucketUnit } from '@classytic/repo-core/repository';

/**
 * Compile a `AggDateBucket` to the mongo expression that produces the
 * bucket label string for a single document. Used in two places:
 *
 *   1. Inside `$group._id` so the aggregator groups by the bucket
 *      label (one row per distinct bucket).
 *   2. Inside `$project` to flatten `_id.<alias>` into a top-level
 *      column on the output row — matches the cross-kit shape.
 */

/**
 * Reject an unknown IANA zone HERE, not at the server.
 *
 * `@classytic/primitives` owns the canonical `isValidTimeZone`, but this is a
 * storage kit and must not take a domain dependency for one validator — so it
 * mirrors the primitive's implementation exactly: construct an `Intl` formatter
 * for the zone and treat the `RangeError` as the answer. ICU is the same source
 * of truth either way, so the two cannot disagree about which zones exist.
 *
 * Without this, a typo (`Asia/Dahka`) travels all the way to Mongo and comes
 * back as a server-side "unrecognized time zone identifier" attached to whatever
 * query happened to run — at request time, far from the aggregation that set
 * it. Failing at compile time names the field and the value.
 */
const validatedZones = new Set<string>(['UTC']);
function assertValidTimeZone(zone: string): void {
  if (validatedZones.has(zone)) return;
  try {
    // The formatter is the probe; constructing it is what throws.
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new Error(
      `mongokit/aggregate: dateBucket.timezone is not a valid IANA zone — got ${JSON.stringify(zone)}. ` +
        'Use a name like "Asia/Dhaka" or "America/New_York"; omit the field for UTC.',
    );
  }
  validatedZones.add(zone);
}

export function compileDateBucket(bucket: AggDateBucket): unknown {
  const dateExpr = { $toDate: `$${bucket.field}` };
  /**
   * Bucket boundaries are drawn in `bucket.timezone`, defaulting to UTC.
   *
   * Every branch below used to hardcode `'UTC'`, which made the portable IR
   * unusable for any business-day rollup: in a UTC+6 deployment the 18:00–
   * midnight rows land on the previous day and, at month-end, in the previous
   * month — silently. Consumers therefore abandoned the IR and hand-rolled
   * `$dateToString` pipelines, where the zone became optional and was
   * forgotten (see the daily profit rollup that bucketed on UTC days).
   *
   * Mongo takes an IANA zone natively on both operators, so honouring it here
   * costs nothing and makes the correct thing expressible. Gated by the
   * `dateBucketTimezone` capability for kits that cannot do it.
   */
  const timezone = bucket.timezone ?? 'UTC';
  assertValidTimeZone(timezone);

  // Custom bin form — `{ every, unit }`. `$dateTrunc` (Mongo 5+)
  // snaps the date to the bin start; `$dateToString` formats the
  // start to a canonical label.
  if (typeof bucket.interval === 'object') {
    const { every, unit } = bucket.interval;
    if (!Number.isInteger(every) || every <= 0) {
      throw new Error(
        `mongokit/aggregate: dateBucket.interval.every must be a positive integer — got ${String(every)}`,
      );
    }
    const truncated = {
      $dateTrunc: { date: dateExpr, unit, binSize: every, timezone },
    };
    return { $dateToString: { format: formatForUnit(unit), date: truncated, timezone } };
  }

  // Named-bucket form — fixed format strings.
  switch (bucket.interval) {
    case 'minute':
      return {
        $dateToString: { format: '%Y-%m-%dT%H:%M', date: dateExpr, timezone },
      };

    case 'hour':
      return {
        $dateToString: { format: '%Y-%m-%dT%H:00', date: dateExpr, timezone },
      };

    case 'day':
      return { $dateToString: { format: '%Y-%m-%d', date: dateExpr, timezone } };

    case 'week':
      // `%G` = ISO 8601 week-numbering year (NOT calendar year — they
      // diverge for late-Dec / early-Jan dates that fall into the
      // adjacent ISO week). `%V` = ISO 8601 week number (01–53), zero-
      // padded. Together they're sortable and unambiguous.
      return { $dateToString: { format: '%G-W%V', date: dateExpr, timezone } };

    case 'month':
      return { $dateToString: { format: '%Y-%m', date: dateExpr, timezone } };

    case 'quarter':
      // Mongo has no `%q` specifier. Compose the label from year +
      // computed quarter. `$ceil($divide($month, 3))` maps months 1–3 → 1,
      // 4–6 → 2, 7–9 → 3, 10–12 → 4.
      return {
        $concat: [
          { $dateToString: { format: '%Y', date: dateExpr, timezone } },
          '-Q',
          {
            $toString: {
              $ceil: {
                $divide: [{ $month: { date: dateExpr, timezone } }, 3],
              },
            },
          },
        ],
      };

    case 'year':
      return { $dateToString: { format: '%Y', date: dateExpr, timezone } };
  }
}

/**
 * Choose the canonical label format for a custom-bin unit. Matches
 * the named-bucket label when `every === 1` so the cross-kit row
 * shape stays consistent regardless of which surface form the caller
 * picked.
 */
function formatForUnit(unit: AggDateBucketUnit): string {
  switch (unit) {
    case 'minute':
      return '%Y-%m-%dT%H:%M';
    case 'hour':
      return '%Y-%m-%dT%H:00';
    case 'day':
      return '%Y-%m-%d';
    case 'week':
      return '%G-W%V';
    case 'month':
      return '%Y-%m';
    case 'quarter':
    case 'year':
      // Custom-bin form excludes these via the IR's `Exclude<…>`
      // narrow. Defensive default in case the type guard slips.
      return '%Y';
  }
}
