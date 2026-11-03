/**
 * Period-scoped sequences (G-OCC-2): counters that reset every civil
 * year / month / day in an IANA time zone, with the period derived by the
 * kit (DST-safe, independent of the process `TZ`).
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  civilPeriodKey,
  createSequenceCounter,
  customIdPlugin,
  dateSequentialId,
  getNextPeriodSequence,
  getNextSequence,
  periodCounterKey,
  Repository,
  readSequence,
  withTransaction,
} from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

const BASE = 'PeriodSeqTest.occurrence';
const COLL = 'app_counters_periodtest';

beforeAll(async () => {
  await connectDB();
});
afterAll(async () => {
  await disconnectDB();
});
beforeEach(async () => {
  await mongoose.connection
    .collection('_mongokit_counters')
    .deleteMany({ _id: { $regex: /^PeriodSeqTest/ } as never });
  await mongoose.connection.collection(COLL).deleteMany({});
});

describe('civilPeriodKey', () => {
  it('turns the year at local midnight in the zone, not at UTC midnight', () => {
    // Riyadh is UTC+3 all year: 21:00Z on 31 Dec is 00:00 on 1 Jan.
    const lastSecond = new Date('2026-12-31T20:59:59.999Z');
    const firstInstant = new Date('2026-12-31T21:00:00.000Z');
    expect(civilPeriodKey(lastSecond, 'year', 'Asia/Riyadh')).toBe('2026');
    expect(civilPeriodKey(firstInstant, 'year', 'Asia/Riyadh')).toBe('2027');
    expect(civilPeriodKey(firstInstant, 'year', 'UTC')).toBe('2026');
    expect(civilPeriodKey(firstInstant, 'month', 'Asia/Riyadh')).toBe('2027-01');
    expect(civilPeriodKey(firstInstant, 'day', 'Asia/Riyadh')).toBe('2027-01-01');
    // West of UTC the year turns later: 1 Jan 03:00Z is still 31 Dec in New York.
    expect(civilPeriodKey(new Date('2027-01-01T03:00:00Z'), 'year', 'America/New_York')).toBe(
      '2026',
    );
  });

  it('is DST-safe: days around both New York transitions map to the wall-clock date', () => {
    // Spring forward 2026-03-08 02:00 EST -> 03:00 EDT; fall back 2026-11-01 02:00 EDT -> 01:00 EST.
    const ny = 'America/New_York';
    expect(civilPeriodKey(new Date('2026-03-08T04:59:59Z'), 'day', ny)).toBe('2026-03-07'); // 23:59:59 EST
    expect(civilPeriodKey(new Date('2026-03-08T05:00:00Z'), 'day', ny)).toBe('2026-03-08'); // 00:00 EST
    expect(civilPeriodKey(new Date('2026-03-09T03:59:59Z'), 'day', ny)).toBe('2026-03-08'); // 23:59:59 EDT
    expect(civilPeriodKey(new Date('2026-03-09T04:00:00Z'), 'day', ny)).toBe('2026-03-09'); // 00:00 EDT
    expect(civilPeriodKey(new Date('2026-11-01T03:59:59Z'), 'day', ny)).toBe('2026-10-31'); // 23:59:59 EDT
    expect(civilPeriodKey(new Date('2026-11-01T04:00:00Z'), 'day', ny)).toBe('2026-11-01'); // 00:00 EDT
    expect(civilPeriodKey(new Date('2026-11-02T04:59:59Z'), 'day', ny)).toBe('2026-11-01'); // 23:59:59 EST (25 h day)
    expect(civilPeriodKey(new Date('2026-11-02T05:00:00Z'), 'day', ny)).toBe('2026-11-02');
  });

  it('follows zone-rule changes: Samoa skipped 30 Dec 2011', () => {
    expect(civilPeriodKey(new Date('2011-12-30T09:59:59Z'), 'day', 'Pacific/Apia')).toBe(
      '2011-12-29',
    );
    expect(civilPeriodKey(new Date('2011-12-30T10:00:00Z'), 'day', 'Pacific/Apia')).toBe(
      '2011-12-31',
    );
  });

  it('rejects bad input', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    expect(() => civilPeriodKey(at, 'year', 'Mars/Olympus')).toThrow(/unknown time zone/);
    expect(() => civilPeriodKey(at, 'year', '')).toThrow(/non-empty IANA/);
    expect(() => civilPeriodKey(at, 'week' as never, 'UTC')).toThrow(/period must be/);
    expect(() => civilPeriodKey(new Date(Number.NaN), 'year', 'UTC')).toThrow(/valid Date/);
  });
});

describe('getNextPeriodSequence', () => {
  it('derives the key, resets per civil year in the zone, and reports the period', async () => {
    const opts = { period: 'year' as const, timeZone: 'Asia/Riyadh' };
    const a = await getNextPeriodSequence(BASE, {
      ...opts,
      at: new Date('2026-12-31T20:00:00Z'),
    });
    const b = await getNextPeriodSequence(BASE, {
      ...opts,
      at: new Date('2026-12-31T20:59:59Z'),
    });
    const c = await getNextPeriodSequence(BASE, {
      ...opts,
      at: new Date('2026-12-31T21:00:00Z'),
    });
    expect(a).toEqual({ seq: 1, period: '2026', counterKey: `${BASE}:2026` });
    expect(b).toEqual({ seq: 2, period: '2026', counterKey: `${BASE}:2026` });
    expect(c).toEqual({ seq: 1, period: '2027', counterKey: `${BASE}:2027` });
    // The same counter documents the plain API sees.
    expect(await readSequence(`${BASE}:2026`)).toBe(2);
    expect(await getNextSequence(`${BASE}:2027`)).toBe(2);
  });

  it('keySeparator keeps counters an app already created by hand', async () => {
    // The app used `getNextSequence('PeriodSeqTest.occurrence.2026')` before.
    await getNextSequence(`${BASE}.2026`, 41);
    const r = await getNextPeriodSequence(BASE, {
      period: 'year',
      timeZone: 'Asia/Riyadh',
      at: new Date('2026-06-01T00:00:00Z'),
      keySeparator: '.',
    });
    expect(r).toEqual({ seq: 42, period: '2026', counterKey: `${BASE}.2026` });
    expect(
      periodCounterKey(BASE, {
        period: 'month',
        timeZone: 'UTC',
        at: new Date('2026-06-01T00:00:00Z'),
      }),
    ).toEqual({
      counterKey: `${BASE}:2026-06`,
      period: '2026-06',
    });
  });

  it('does not depend on the process TZ', async () => {
    const previous = process.env.TZ;
    const at = new Date('2026-12-31T22:00:00Z');
    try {
      process.env.TZ = 'Pacific/Kiritimati'; // UTC+14: local date is already 1 Jan 2027
      const kiritimati = periodCounterKey(BASE, {
        period: 'year',
        timeZone: 'America/New_York',
        at,
      });
      process.env.TZ = 'Pacific/Pago_Pago'; // UTC-11
      const pagoPago = periodCounterKey(BASE, { period: 'year', timeZone: 'America/New_York', at });
      expect(kiritimati.period).toBe('2026');
      expect(pagoPago.period).toBe('2026');
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it('createSequenceCounter().nextInPeriod honours the collection and the session', async () => {
    const counters = createSequenceCounter({ collection: COLL });
    const opts = {
      period: 'month' as const,
      timeZone: 'Asia/Riyadh',
      at: new Date('2026-03-31T21:30:00Z'), // 1 Apr 00:30 Riyadh
    };
    expect(await counters.nextInPeriod(BASE, opts)).toEqual({
      seq: 1,
      period: '2026-04',
      counterKey: `${BASE}:2026-04`,
    });
    expect(await counters.read(`${BASE}:2026-04`)).toBe(1);
    expect(await readSequence(`${BASE}:2026-04`)).toBeNull(); // default collection untouched

    await expect(
      withTransaction(mongoose.connection, async (session) => {
        await counters.nextInPeriod(BASE, { ...opts, session });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await counters.read(`${BASE}:2026-04`)).toBe(1);
  });

  it('validates its inputs', async () => {
    await expect(getNextPeriodSequence('', { period: 'year', timeZone: 'UTC' })).rejects.toThrow(
      /baseKey/,
    );
    await expect(
      getNextPeriodSequence(BASE, { period: 'year', timeZone: 'Nowhere/Land' }),
    ).rejects.toThrow(/unknown time zone/);
  });
});

describe('dateSequentialId — IANA timeZone, at, counterKey', () => {
  interface IOcc {
    ref?: string;
    reportedAt: Date;
  }
  let OccModel: mongoose.Model<IOcc>;

  beforeAll(async () => {
    OccModel = await createTestModel(
      'PeriodSeqTestOcc',
      new Schema<IOcc>({ ref: String, reportedAt: { type: Date, required: true } }),
    );
  });
  beforeEach(async () => {
    await OccModel.deleteMany({});
  });

  it('numbers each record in the civil year of its own instant in the zone', async () => {
    const repo = new Repository<IOcc>(OccModel, [
      customIdPlugin({
        field: 'ref',
        generator: dateSequentialId({
          prefix: 'OC',
          model: OccModel,
          partition: 'yearly',
          padding: 6,
          timeZone: 'Asia/Riyadh',
          at: (ctx) => (ctx.data as IOcc | undefined)?.reportedAt,
          counterKey: BASE,
        }),
      }),
    ]);
    const a = await repo.create({ reportedAt: new Date('2026-12-31T20:59:59Z') });
    const b = await repo.create({ reportedAt: new Date('2026-12-31T21:00:00Z') });
    const c = await repo.create({ reportedAt: new Date('2026-06-01T00:00:00Z') });
    expect(a.ref).toBe('OC-2026-000001');
    expect(b.ref).toBe('OC-2027-000001');
    expect(c.ref).toBe('OC-2026-000002');
    expect(await readSequence(`${BASE}:2026`)).toBe(2);
  });

  it('daily partition in a DST zone and the default key stay as before', async () => {
    const repo = new Repository<IOcc>(OccModel, [
      customIdPlugin({
        field: 'ref',
        generator: dateSequentialId({
          prefix: 'D',
          model: OccModel,
          partition: 'daily',
          timeZone: 'America/New_York',
          at: (ctx) => (ctx.data as IOcc | undefined)?.reportedAt,
        }),
      }),
    ]);
    // 25-hour fall-back day: both instants are 1 Nov in New York.
    const a = await repo.create({ reportedAt: new Date('2026-11-01T04:00:00Z') });
    const b = await repo.create({ reportedAt: new Date('2026-11-02T04:59:59Z') });
    expect(a.ref).toBe('D-2026-11-01-0001');
    expect(b.ref).toBe('D-2026-11-01-0002');
    expect(await readSequence('PeriodSeqTestOcc:2026-11-01')).toBe(2);
    await mongoose.connection
      .collection('_mongokit_counters')
      .deleteMany({ _id: { $regex: /^PeriodSeqTestOcc/ } as never });
  });

  it('rejects a bad zone at construction and a non-Date from at', async () => {
    expect(() => dateSequentialId({ prefix: 'X', model: OccModel, timeZone: 'Not/AZone' })).toThrow(
      /unknown time zone/,
    );
    expect(() => dateSequentialId({ prefix: 'X', model: OccModel, counterKey: '' })).toThrow(
      /counterKey/,
    );
    const gen = dateSequentialId({
      prefix: 'X',
      model: OccModel,
      timeZone: 'UTC',
      at: () => '2026-01-01' as never,
    });
    await expect(gen({ operation: 'create' } as never)).rejects.toThrow(/valid Date/);
  });
});
