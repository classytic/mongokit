/**
 * `readSequence` / `ensureSequenceAtLeast` — seeding a counter so a new key
 * never re-issues ids already issued under an old one.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureSequenceAtLeast, getNextSequence, readSequence } from '../../src/index.js';
import { connectDB, disconnectDB } from '../setup.js';

const KEY = 'SeedingTest:tenant-a:2026';
const counters = () =>
  mongoose.connection.collection<{ _id: string; seq: number }>('_mongokit_counters');

beforeAll(async () => {
  await connectDB();
});

afterAll(async () => {
  await disconnectDB();
});

beforeEach(async () => {
  await counters().deleteMany({ _id: { $regex: '^SeedingTest:' } });
});

describe('readSequence', () => {
  it('is null for a counter that was never created, and the value once it exists', async () => {
    expect(await readSequence(KEY)).toBeNull();
    await getNextSequence(KEY);
    expect(await readSequence(KEY)).toBe(1);
  });
});

describe('ensureSequenceAtLeast', () => {
  it('seeds a missing counter so the next id continues after the floor', async () => {
    await ensureSequenceAtLeast(KEY, 380);
    expect(await getNextSequence(KEY)).toBe(381);
  });

  it('never lowers a counter that is already ahead', async () => {
    await getNextSequence(KEY, 500);
    expect(await ensureSequenceAtLeast(KEY, 380)).toBe(500);
    expect(await getNextSequence(KEY)).toBe(501);
  });

  it('concurrent seeders converge on the highest floor', async () => {
    await Promise.all([10, 380, 42, 7].map((f) => ensureSequenceAtLeast(KEY, f)));
    expect(await readSequence(KEY)).toBe(380);
  });

  it('refuses a floor that is not a non-negative integer', async () => {
    await expect(ensureSequenceAtLeast(KEY, -1)).rejects.toThrow(/non-negative integer/);
    await expect(ensureSequenceAtLeast(KEY, 1.5)).rejects.toThrow(/non-negative integer/);
  });
});
