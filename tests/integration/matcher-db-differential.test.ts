/**
 * Differential drift-gate: the in-memory `matchesRecordFilter` (backing
 * `MongooseAdapter.matchesFilter`, used by arc's realtime feed) MUST return
 * the same yes/no as a REAL MongoDB query for the same filter.
 *
 * "Two implementations of the same filter semantics must agree" is the
 * classic semantic-drift risk (differential-testing territory): if the
 * in-memory matcher and the DB diverge, a realtime subscriber sees a record
 * they shouldn't (leak) or misses one they should. Manual parity tests
 * catch known cases; this catches drift by construction — insert each doc,
 * run the filter through Mongo AND the matcher, assert identical results
 * across a battery of docs × filters that specifically exercise the
 * MongoDB gotchas (missing≡null, $ne/$nin-match-missing, $in-with-null,
 * type bracketing, array element match, id coercion).
 */

import { matchesRecordFilter } from '@classytic/repo-core/filter';
import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectDB, disconnectDB } from '../setup.js';

interface Doc {
  _id: mongoose.Types.ObjectId;
  ownerId?: string | null;
  status?: string | null;
  age?: number;
  tags?: string[];
  tenant?: string | null;
  score?: number;
  [k: string]: unknown;
}

let Model: mongoose.Model<Doc>;

// Docs chosen to sit on the semantic edges: present-null, missing field,
// array field, numeric field, mixed types.
const DOCS: Record<string, unknown>[] = [
  { key: 'a', ownerId: 'u1', status: 'active', age: 30, tags: ['x', 'y'], tenant: 'acme', score: 5 },
  { key: 'b', ownerId: 'u2', status: 'archived', age: 10, tags: ['z'], tenant: 'public', score: 50 },
  { key: 'c', ownerId: null, status: null, age: 0, tags: [], tenant: null, score: 0 }, // present-null
  { key: 'd' /* ownerId, status, age, tags, tenant, score all MISSING */ },
  { key: 'e', ownerId: 'u1', status: 'active', age: 99, tags: ['x'], tenant: 'acme', score: 5 },
];

// Filters that exercise the researched MongoDB gotchas. Each is run through
// BOTH the DB and the in-memory matcher; results must be identical per doc.
const FILTERS: Record<string, unknown>[] = [
  { ownerId: 'u1' }, // implicit eq
  { ownerId: null }, // #1 matches present-null AND missing
  { status: { $ne: 'archived' } }, // #2 matches missing
  { status: { $nin: ['archived'] } }, // #2
  { ownerId: { $in: [null, 'u2'] } }, // #4 null member matches missing
  { tenant: { $nin: [null, 'public'] } }, // #4 requires present + non-null + not public
  { $or: [{ ownerId: 'u2' }, { tenant: 'acme' }] }, // logical
  { age: { $gt: 20 } }, // range
  { age: { $gte: 0, $lt: 30 } }, // range band
  { tags: 'x' }, // array element match (#7)
  { tags: { $in: ['z', 'q'] } }, // array $in
  { score: { $eq: 0 } }, // zero not falsy
  { ownerId: 'u1', status: 'active' }, // field AND
];
// NOTE `$exists` is deliberately EXCLUDED — it's the one documented,
// dialect-divergent operator (see the explicit test below). Arc's built-in
// policy helpers never emit it.

describe('matchesRecordFilter ⇄ MongoDB differential (drift gate)', () => {
  const seeded: Doc[] = [];

  beforeAll(async () => {
    await connectDB();
    if (mongoose.models.DiffDoc) delete mongoose.models.DiffDoc;
    Model = mongoose.model<Doc>(
      'DiffDoc',
      new Schema(
        {
          key: { type: String },
          ownerId: { type: String, default: undefined },
          status: { type: String, default: undefined },
          age: { type: Number, default: undefined },
          tags: { type: [String], default: undefined },
          tenant: { type: String, default: undefined },
          score: { type: Number, default: undefined },
        },
        { strict: false, minimize: false },
      ),
    );
    await Model.init();
    await Model.deleteMany({});
    for (const d of DOCS) {
      const created = await Model.create(d);
      seeded.push(created.toObject() as Doc);
    }
  });

  afterAll(async () => {
    await Model?.deleteMany({});
    await disconnectDB();
  });

  it('every (filter × doc) pair: matcher agrees with the DB', async () => {
    const disagreements: string[] = [];
    for (const filter of FILTERS) {
      // What the DB says: which keys match this filter?
      const dbMatched = new Set(
        (await Model.find(filter as mongoose.FilterQuery<Doc>).lean()).map((d) => d.key as string),
      );
      for (const doc of seeded) {
        const dbSays = dbMatched.has(doc.key as string);
        const matcherSays = matchesRecordFilter(doc, filter);
        if (dbSays !== matcherSays) {
          disagreements.push(
            `filter=${JSON.stringify(filter)} doc.key=${doc.key}: db=${dbSays} matcher=${matcherSays}`,
          );
        }
      }
    }
    // A non-empty list means the in-memory matcher would leak or hide a row
    // vs the real query — a live authorization-drift bug. Surface all of them.
    expect(disagreements).toEqual([]);
  });

  it('documents the ONE known divergence: $exists on a present-null value', async () => {
    // MongoDB `$exists: true` is KEY-PRESENCE (a present-`null` counts as
    // existing); the shared matcher treats present-null as absent (matches
    // the IR `exists` op + SQL `IS NOT NULL` + sift.js). This is the sole
    // matcher⇄Mongo divergence — pinned here so it stays deliberate and any
    // OTHER $exists drift would surface. Arc's built-in helpers never emit
    // `$exists`; use `{ field: { $ne: null } }` for present-non-null.
    const docC = seeded.find((d) => d.key === 'c') as Doc; // status: null
    const dbIncludesC = (await Model.find({ status: { $exists: true } }).lean()).some(
      (d) => d.key === 'c',
    );
    expect(dbIncludesC).toBe(true); // Mongo: present-null exists
    expect(matchesRecordFilter(docC, { status: { $exists: true } })).toBe(false); // matcher: non-null
  });
});
