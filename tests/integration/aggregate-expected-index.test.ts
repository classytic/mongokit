/**
 * `indexHint: { leadingKeys }` is an EXPECTED index — validated against the model's declared
 * indexes, never forced. Forcing it as `{ field: 1 }` failed `BadValue` whenever only a longer
 * index led with that field, and overrode the planner when it did not.
 */
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRow {
  organizationId: string;
  status: string;
  createdAt: Date;
}

describe('aggregate — indexHint { leadingKeys } is checked, not forced', () => {
  let repo: Repository<IRow>;

  beforeAll(async () => {
    await connectDB();
    const schema = new mongoose.Schema<IRow>({ organizationId: String, status: String, createdAt: Date });
    // Only LONGER indexes lead with these fields — no `{ status: 1 }` exists.
    schema.index({ organizationId: 1, status: 1, createdAt: -1 });
    schema.index({ createdAt: -1, _id: -1 });
    const Model = await createTestModel('AggExpectedIndex', schema);
    repo = new Repository<IRow>(Model);
    await Model.insertMany([
      { organizationId: 'o1', status: 'a', createdAt: new Date() },
      { organizationId: 'o1', status: 'b', createdAt: new Date() },
      { organizationId: 'o2', status: 'a', createdAt: new Date() },
    ]);
  });
  afterAll(async () => {
    await disconnectDB();
  });

  it('runs when a declared index leads with the keys after a scope field (no BadValue)', async () => {
    const { rows } = await repo.aggregate<{ status: string; n: number }>({
      filter: { organizationId: 'o1' },
      groupBy: ['status'],
      measures: { n: { op: 'count' } },
      executionHints: { indexHint: { leadingKeys: ['status'] } },
    });
    expect(rows.map((r) => [r.status, r.n]).sort()).toEqual([['a', 1], ['b', 1]]);
  });

  it('runs when a declared index leads with the keys directly', async () => {
    const { rows } = await repo.aggregate<{ n: number }>({
      measures: { n: { op: 'count' } },
      executionHints: { indexHint: { leadingKeys: ['createdAt'] } },
    });
    expect(rows[0]?.n).toBe(3);
  });

  it('refuses an expectation no declared index meets, naming what is declared', async () => {
    await expect(
      repo.aggregate({ measures: { n: { op: 'count' } }, executionHints: { indexHint: { leadingKeys: ['nope'] } } }),
    ).rejects.toThrow(/expects an index leading with \(nope\).*declared: \(organizationId,status,createdAt\)/);
  });
});
