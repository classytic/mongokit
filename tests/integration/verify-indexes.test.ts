/**
 * `verifyIndexes` against a REAL database.
 *
 * A mock cannot prove this: every subtlety here is a fact about how mongo
 * STORES an index, not about how a schema declares one — a text index moves its
 * fields into `weights` under an invented `{_fts,_ftsx}` key, and a
 * single-field numeric index is stored without a usable direction. Both were
 * found by a check that reported permanently-missing indexes that existed.
 *
 * The unique/regular split is the point of the whole thing: a missing unique
 * index has already been admitting duplicate rows; a missing regular one only
 * costs a scan.
 */
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyIndexes, formatIndexReport } from '../../src/indexes/verify-indexes.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IWidget {
  slug?: string;
  tenant?: string;
  seq?: number;
  title?: string;
}

let model: mongoose.Model<IWidget>;

beforeAll(async () => {
  await connectDB();
  const schema = new mongoose.Schema<IWidget>({
    slug: String,
    tenant: String,
    seq: Number,
    title: String,
  });
  schema.index({ slug: 1 }, { unique: true });
  schema.index({ tenant: 1, seq: -1 });
  schema.index({ title: 'text' });
  model = await createTestModel<IWidget>('VerifyWidget', schema);
  await model.createCollection();
  // DROP them: mongoose's autoIndex builds declared indexes on model compile,
  // so the unbuilt state this check exists to catch has to be created on
  // purpose. Asserting against the default would have proved nothing.
  await model.collection.dropIndexes().catch(() => {});
}, 60_000);

afterAll(async () => {
  await disconnectDB();
});

const reportFor = () =>
  verifyIndexes(mongoose.connection as never, { includeModel: (n) => n === 'VerifyWidget' });

describe('verifyIndexes', () => {
  it('reports a declared-but-absent UNIQUE index separately from a regular one', async () => {
    const report = await reportFor();

    expect(report.modelsChecked).toBe(1);
    expect(report.missingUnique.map((m) => m.key)).toEqual([JSON.stringify({ slug: 1 })]);
    // The compound and the text index are both missing, but neither is unique.
    expect(report.missingRegular.length).toBe(2);
    // Naming matters: a count alone cannot be acted on.
    expect(report.missingUnique[0]?.model).toBe('VerifyWidget');
    expect(report.missingUnique[0]?.collection).toBeTruthy();
  });

  it('sees the indexes once they are actually built', async () => {
    await model.syncIndexes();
    const report = await reportFor();

    expect(report.missingUnique).toEqual([]);
    expect(report.missingRegular).toEqual([]);
  });

  it('does not report a TEXT index as missing — mongo stores it under `weights`', async () => {
    // Stored as `{_fts:'text',_ftsx:1}` with `title` moved into `weights`, so a
    // key comparison alone reports it missing forever and the check becomes noise.
    const live = await model.collection.listIndexes().toArray();
    const text = live.find((i) => i.weights);
    expect(text, 'the text index must actually exist for this to prove anything').toBeTruthy();
    expect(Object.keys(text?.weights as object)).toContain('title');

    const report = await reportFor();
    expect(report.missingRegular.map((m) => m.key)).not.toContain(JSON.stringify({ title: 'text' }));
  });

  it('treats a single-field numeric index as direction-agnostic', async () => {
    // `{slug:1}` and `{slug:-1}` are the SAME index — mongo traverses either
    // way. A schema declaring the opposite direction is not drift.
    const flipped = new mongoose.Schema<IWidget>({ slug: String });
    flipped.index({ slug: -1 }, { unique: true });
    const other = await createTestModel<IWidget>('VerifyWidgetFlipped', flipped);
    // Point it at the SAME collection, which already has `{slug:1}`.
    Object.defineProperty(other, 'collection', { value: model.collection });

    const report = await verifyIndexes(mongoose.connection as never, {
      includeModel: (n) => n === 'VerifyWidgetFlipped',
    });
    expect(report.missingUnique).toEqual([]);
  });

  it('an index in the DB but not in a schema is NOT drift', async () => {
    await model.collection.createIndex({ tenant: 1, title: 1 }, { name: 'db_only_idx' });
    const report = await reportFor();

    // One-directional on purpose: auth libraries and migrations manage indexes
    // outside the ODM, and calling those removable is what makes syncIndexes unsafe.
    expect(report.missingUnique).toEqual([]);
    expect(report.missingRegular).toEqual([]);
  });

  it('skips a model the caller excludes, and says how many it checked', async () => {
    const none = await verifyIndexes(mongoose.connection as never, { includeModel: () => false });
    expect(none.modelsChecked).toBe(0);
    // A zero sweep must be distinguishable from a clean one.
    expect(formatIndexReport(none)).toContain('0 models checked');
  });

  it('formats a summary that names both counts', () => {
    const line = formatIndexReport({
      modelsChecked: 3,
      missingUnique: [{ model: 'A', collection: 'a', key: '{}' }],
      missingRegular: [],
      unreadable: ['B'],
    });
    expect(line).toContain('3 models checked');
    expect(line).toContain('missing unique: 1');
    expect(line).toContain('unreadable: 1');
  });
});
