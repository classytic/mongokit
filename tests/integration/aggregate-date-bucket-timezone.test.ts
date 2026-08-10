/**
 * `AggDateBucket.timezone` — bucket boundaries drawn in an IANA zone.
 *
 * ## Why this exists
 *
 * Every branch of `compileDateBucket` used to hardcode `timezone: 'UTC'`, so
 * the portable IR could not express a BUSINESS day. In a UTC+6 deployment that
 * puts every row from 18:00 to midnight local on the PREVIOUS day, and at
 * month-end in the previous month — silently. Consumers therefore abandoned the
 * IR and hand-rolled `$dateToString` pipelines, where the zone became optional
 * and duly got forgotten: a daily profit rollup shipped bucketing on UTC days.
 *
 * Each case below uses a timestamp INSIDE the offset window, so a regression to
 * UTC changes the asserted label rather than merely failing to set an option.
 * A test whose data sits at midday would pass under either behaviour.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IOrder {
  _id?: mongoose.Types.ObjectId;
  status: string;
  amount: number;
  createdAt: Date;
}

function makeSchema() {
  return new mongoose.Schema<IOrder>(
    {
      status: { type: String, required: true },
      amount: { type: Number, required: true },
      createdAt: { type: Date, required: true },
    },
    { timestamps: false },
  );
}

const utc = (iso: string) => new Date(iso);
/** Asia/Dhaka is UTC+6 with no DST — a clean fixed offset. */
const DHAKA = 'Asia/Dhaka';

describe('aggregate (portable IR) — date bucket timezone', () => {
  let Model: mongoose.Model<IOrder>;
  let repo: Repository<IOrder>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('AggDateBucketTz', makeSchema());
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    repo = new Repository<IOrder>(Model);
    await repo.createMany([
      // 2026-01-15 20:30 Dhaka — still 14:30 UTC on the 15th. Same day either way.
      { status: 'paid', amount: 100, createdAt: utc('2026-01-15T14:30:00Z') },
      // 2026-01-16 01:00 Dhaka — but 19:00 UTC on the 15th. THE case: UTC says
      // the 15th, Dhaka says the 16th.
      { status: 'paid', amount: 200, createdAt: utc('2026-01-15T19:00:00Z') },
      // 2026-02-01 03:00 Dhaka — but 21:00 UTC on Jan 31. UTC says January,
      // Dhaka says February: the month-end slip.
      { status: 'paid', amount: 400, createdAt: utc('2026-01-31T21:00:00Z') },
    ]);
  });

  it('buckets a DAY on the business boundary, not the UTC one', async () => {
    const { rows } = await repo.aggregate<{ day: string; revenue: number }>({
      filter: { status: 'paid' },
      dateBuckets: { day: { field: 'createdAt', interval: 'day', timezone: DHAKA } },
      measures: { revenue: { op: 'sum', field: 'amount' } },
      sort: { day: 1 },
    });
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r.revenue]));
    // 19:00Z on the 15th is 01:00 on the 16th in Dhaka — it must NOT join the
    // 14:30Z row on the 15th.
    expect(byDay['2026-01-15']).toBe(100);
    expect(byDay['2026-01-16']).toBe(200);
  });

  it('defaults to UTC when no timezone is given (unchanged behaviour)', async () => {
    const { rows } = await repo.aggregate<{ day: string; revenue: number }>({
      filter: { status: 'paid' },
      dateBuckets: { day: { field: 'createdAt', interval: 'day' } },
      measures: { revenue: { op: 'sum', field: 'amount' } },
      sort: { day: 1 },
    });
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r.revenue]));
    // Both Jan-15 rows collapse under UTC — this is exactly the conflation the
    // timezone option exists to prevent, pinned so the default cannot drift.
    expect(byDay['2026-01-15']).toBe(300);
    expect(byDay['2026-01-16']).toBeUndefined();
  });

  it('buckets a MONTH on the business boundary — the month-end slip', async () => {
    const { rows } = await repo.aggregate<{ month: string; revenue: number }>({
      filter: { status: 'paid' },
      dateBuckets: { month: { field: 'createdAt', interval: 'month', timezone: DHAKA } },
      measures: { revenue: { op: 'sum', field: 'amount' } },
      sort: { month: 1 },
    });
    const byMonth = Object.fromEntries(rows.map((r) => [r.month, r.revenue]));
    // 21:00Z Jan 31 is 03:00 Feb 1 in Dhaka. Under UTC this lands in January
    // and understates February — the `aggregateMonthlyVat` failure shape.
    expect(byMonth['2026-01']).toBe(300);
    expect(byMonth['2026-02']).toBe(400);
  });

  it('honours the timezone for CUSTOM bins too, not just named intervals', async () => {
    const { rows } = await repo.aggregate<{ bin: string; revenue: number }>({
      filter: { status: 'paid' },
      dateBuckets: {
        bin: { field: 'createdAt', interval: { every: 1, unit: 'day' }, timezone: DHAKA },
      },
      measures: { revenue: { op: 'sum', field: 'amount' } },
      sort: { bin: 1 },
    });
    const byBin = Object.fromEntries(rows.map((r) => [r.bin, r.revenue]));
    // `$dateTrunc` AND the `$dateToString` that labels it both take the zone —
    // truncating in Dhaka then formatting in UTC would re-introduce the slip.
    expect(byBin['2026-01-15']).toBe(100);
    expect(byBin['2026-01-16']).toBe(200);
  });

  it('rejects an unknown zone at compile time, not at the server', async () => {
    // A typo must name the field and the value, not surface later as an opaque
    // Mongo "unrecognized time zone identifier" on whatever query ran.
    await expect(
      repo.aggregate({
        filter: { status: 'paid' },
        dateBuckets: { day: { field: 'createdAt', interval: 'day', timezone: 'Asia/Dahka' } },
        measures: { revenue: { op: 'sum', field: 'amount' } },
      }),
    ).rejects.toThrow(/not a valid IANA zone/);
  });

  it('declares the capability it implements', async () => {
    const { MONGOKIT_CAPABILITIES } = await import('../../src/capabilities.js');
    // A capability nothing enforces is decoration; a capability implemented but
    // undeclared means a host cannot detect it. Both must agree.
    expect(MONGOKIT_CAPABILITIES.aggregateOps?.dateBucketTimezone).toBe(true);
  });
});
