/**
 * Integration tests for the extended date-bucket interval surface:
 *
 *   - Named buckets `'minute'` / `'hour'` (added alongside the
 *     existing day/week/month/quarter/year set).
 *   - Custom-bin form `{ every: N, unit }` for arbitrary intervals
 *     (15-minute bins, 6-hour bins, 7-day bins).
 *
 * Cross-kit parity: same input → same output rows on sqlitekit's
 * parallel test file. Bucket labels are canonical ISO-shaped strings,
 * sortable lexicographically.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IEvent {
  _id?: mongoose.Types.ObjectId;
  occurredAt: Date;
  count: number;
}

function makeSchema() {
  return new mongoose.Schema<IEvent>(
    {
      occurredAt: { type: Date, required: true },
      count: { type: Number, required: true },
    },
    { timestamps: false },
  );
}

const utc = (iso: string) => new Date(iso);

describe('aggregate (portable IR) — bucket intervals', () => {
  let Model: mongoose.Model<IEvent>;
  let repo: Repository<IEvent>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('AggBucketIntervals', makeSchema());
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    repo = new Repository<IEvent>(Model);
  });

  it('minute bucket emits YYYY-MM-DDTHH:MM', async () => {
    await repo.createMany([
      { occurredAt: utc('2026-04-15T10:00:30Z'), count: 1 },
      { occurredAt: utc('2026-04-15T10:00:45Z'), count: 1 },
      { occurredAt: utc('2026-04-15T10:01:00Z'), count: 1 },
    ]);
    const { rows } = await repo.aggregate<{ minute: string; n: number }>({
      dateBuckets: { minute: { field: 'occurredAt', interval: 'minute' } },
      measures: { n: { op: 'count' } },
      sort: { minute: 1 },
    });
    expect(rows).toEqual([
      { minute: '2026-04-15T10:00', n: 2 },
      { minute: '2026-04-15T10:01', n: 1 },
    ]);
  });

  it('hour bucket emits YYYY-MM-DDTHH:00', async () => {
    await repo.createMany([
      { occurredAt: utc('2026-04-15T10:15:00Z'), count: 1 },
      { occurredAt: utc('2026-04-15T10:45:00Z'), count: 1 },
      { occurredAt: utc('2026-04-15T11:05:00Z'), count: 1 },
    ]);
    const { rows } = await repo.aggregate<{ hour: string; n: number }>({
      dateBuckets: { hour: { field: 'occurredAt', interval: 'hour' } },
      measures: { n: { op: 'count' } },
      sort: { hour: 1 },
    });
    expect(rows).toEqual([
      { hour: '2026-04-15T10:00', n: 2 },
      { hour: '2026-04-15T11:00', n: 1 },
    ]);
  });

  it('custom 15-minute bins', async () => {
    await repo.createMany([
      { occurredAt: utc('2026-04-15T10:00:00Z'), count: 1 },
      { occurredAt: utc('2026-04-15T10:14:59Z'), count: 1 },
      { occurredAt: utc('2026-04-15T10:15:00Z'), count: 1 },
      { occurredAt: utc('2026-04-15T10:29:59Z'), count: 1 },
      { occurredAt: utc('2026-04-15T10:30:00Z'), count: 1 },
    ]);
    const { rows } = await repo.aggregate<{ bin: string; n: number }>({
      dateBuckets: {
        bin: { field: 'occurredAt', interval: { every: 15, unit: 'minute' } },
      },
      measures: { n: { op: 'count' } },
      sort: { bin: 1 },
    });
    expect(rows).toEqual([
      { bin: '2026-04-15T10:00', n: 2 },
      { bin: '2026-04-15T10:15', n: 2 },
      { bin: '2026-04-15T10:30', n: 1 },
    ]);
  });

  it('custom 6-hour bins', async () => {
    await repo.createMany([
      { occurredAt: utc('2026-04-15T00:30:00Z'), count: 1 },
      { occurredAt: utc('2026-04-15T05:00:00Z'), count: 1 },
      { occurredAt: utc('2026-04-15T06:00:00Z'), count: 1 },
      { occurredAt: utc('2026-04-15T11:00:00Z'), count: 1 },
      { occurredAt: utc('2026-04-15T12:30:00Z'), count: 1 },
    ]);
    const { rows } = await repo.aggregate<{ bin: string; n: number }>({
      dateBuckets: {
        bin: { field: 'occurredAt', interval: { every: 6, unit: 'hour' } },
      },
      measures: { n: { op: 'count' } },
      sort: { bin: 1 },
    });
    expect(rows).toEqual([
      { bin: '2026-04-15T00:00', n: 2 },
      { bin: '2026-04-15T06:00', n: 2 },
      { bin: '2026-04-15T12:00', n: 1 },
    ]);
  });

  it('throws on non-positive `every`', async () => {
    await repo.create({ occurredAt: utc('2026-04-15T10:00:00Z'), count: 1 });
    await expect(
      repo.aggregate({
        dateBuckets: {
          bad: { field: 'occurredAt', interval: { every: 0, unit: 'minute' } },
        },
        measures: { n: { op: 'count' } },
      }),
    ).rejects.toThrow(/dateBucket\.interval\.every must be a positive integer/);
  });
});
