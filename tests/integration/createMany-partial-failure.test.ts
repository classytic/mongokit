/**
 * createMany() partial-failure hook semantics.
 *
 * Pins the contract for what the Repository emits when insertMany rejects
 * mid-batch with `ordered: false`:
 *   - the error propagates
 *   - after:createMany does NOT fire on failure (contract: success-only)
 *   - error:createMany fires
 *   - the docs that succeeded before the conflict remain persisted
 *
 * If any of these flip silently, cache invalidation / audit logging can
 * start double-firing or missing events.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IPartialDoc {
  slug: string;
  name: string;
}

function makeSchema() {
  return new mongoose.Schema<IPartialDoc>(
    {
      slug: { type: String, required: true, unique: true },
      name: { type: String, required: true },
    },
    { timestamps: true },
  );
}

describe('createMany — partial failure semantics (integration)', () => {
  let Model: mongoose.Model<IPartialDoc>;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    if (Model) await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    Model = await createTestModel('CreateManyPartialDoc', makeSchema());
    await Model.deleteMany({});
  });

  it('unordered createMany with one conflict — valid docs persist, after: hook does not fire, error: hook fires', async () => {
    const repo = new Repository<IPartialDoc>(Model);
    await repo.create({ slug: 'existing', name: 'seed' });

    const afterCalls: unknown[] = [];
    const errorCalls: unknown[] = [];
    repo.on('after:createMany', async (payload: unknown) => {
      afterCalls.push(payload);
    });
    repo.on('error:createMany', async (payload: unknown) => {
      errorCalls.push(payload);
    });

    const batch = [
      { slug: 'fresh-1', name: 'one' },
      { slug: 'existing', name: 'conflicts' }, // duplicate
      { slug: 'fresh-2', name: 'two' },
    ];

    // ordered: false is the default for createMany in mongokit (see actions/create.ts).
    await expect(repo.createMany(batch)).rejects.toBeTruthy();

    // Non-conflicting docs landed (unordered insertMany carried on past the error).
    const persisted = await repo.findAll({});
    const slugs = new Set(persisted.map((d) => (d as IPartialDoc).slug));
    expect(slugs.has('fresh-1')).toBe(true);
    expect(slugs.has('fresh-2')).toBe(true);
    expect(persisted.length).toBe(3); // seed + fresh-1 + fresh-2

    // Contract: after:createMany fires only on success. error:createMany carries the failure.
    expect(afterCalls.length).toBe(0);
    expect(errorCalls.length).toBe(1);
  });

  it('ordered: true createMany with conflict — stops at conflict, docs before persist, docs after do not', async () => {
    const repo = new Repository<IPartialDoc>(Model);
    await repo.create({ slug: 'existing', name: 'seed' });

    const batch = [
      { slug: 'before', name: 'before' },
      { slug: 'existing', name: 'conflicts' },
      { slug: 'after', name: 'after' },
    ];

    await expect(repo.createMany(batch, { ordered: true })).rejects.toBeTruthy();

    const persisted = await repo.findAll({});
    const slugs = new Set(persisted.map((d) => (d as IPartialDoc).slug));
    expect(slugs.has('before')).toBe(true);
    expect(slugs.has('after')).toBe(false);
    expect(slugs.has('existing')).toBe(true); // only the original seed
  });

  it('fully-successful createMany fires after: once and does not fire error:', async () => {
    const repo = new Repository<IPartialDoc>(Model);

    const afterCalls: unknown[] = [];
    const errorCalls: unknown[] = [];
    repo.on('after:createMany', async (p: unknown) => afterCalls.push(p));
    repo.on('error:createMany', async (p: unknown) => errorCalls.push(p));

    const inserted = await repo.createMany([
      { slug: 's1', name: 'a' },
      { slug: 's2', name: 'b' },
      { slug: 's3', name: 'c' },
    ]);
    expect(inserted).toHaveLength(3);
    expect(afterCalls.length).toBe(1);
    expect(errorCalls.length).toBe(0);
  });

  it('empty array — returns [] without error, after: fires with empty result (current contract)', async () => {
    // Current contract: Repository fires after:createMany even on empty input.
    // Consumers (audit, cache) must tolerate a zero-length result array.
    // This test pins that contract so a silent behavior flip is caught.
    const repo = new Repository<IPartialDoc>(Model);

    const afterCalls: { result: unknown }[] = [];
    const errorCalls: unknown[] = [];
    repo.on('after:createMany', async (payload: { result: unknown }) => {
      afterCalls.push(payload);
    });
    repo.on('error:createMany', async () => {
      errorCalls.push(1);
    });

    const result = await repo.createMany([]);
    expect(result).toEqual([]);
    expect(errorCalls.length).toBe(0);
    // Fires exactly once with an empty-array result.
    expect(afterCalls.length).toBe(1);
    expect(afterCalls[0].result).toEqual([]);
  });
});
