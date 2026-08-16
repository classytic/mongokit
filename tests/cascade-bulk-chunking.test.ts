/**
 * Bulk-path chunking — the bound that keeps `deleteMany` safe at scale.
 *
 * The plugin's bulk path snapshots the matched parent ids and then addresses children with
 * `{fk: {$in: ids}}`. Unsliced, that `$in` grows with the match: around a million ObjectIds
 * the query document passes Mongo's 16 MB limit and the server rejects it — for `restrict`
 * that refuses the whole delete (fail-safe), but for `cascade` it fires AFTER the parents
 * are gone, so the children error and are orphaned. Slicing every `$in` to `batchSize`
 * removes the ceiling; these tests pin the slicing itself, not just the outcomes.
 *
 * Uses a deliberately tiny `batchSize` so multi-slice behaviour is exercised with a small
 * fixture. The load-bearing assertions are DENOMINATORS: the number of calls, each call's
 * `$in` length, and the union of ids across calls — an implementation that quietly drops
 * slicing (one giant `$in`) or drops a slice (missed children) fails a specific line here.
 */

import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cascadePlugin, methodRegistryPlugin, Repository } from '../src/index.js';
import {
  collectIds,
  idChunks,
  keysetFilter,
  narrowToIds,
  selectKeysetChunk,
} from '../src/utils/id-chunks.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

const BATCH = 25;
const PARENTS = 60; // 3 slices: 25 + 25 + 10

const parentSchema = new Schema({ name: String }, { timestamps: true });
const childSchema = new Schema(
  { label: String, parent: { type: Schema.Types.ObjectId, index: true } },
  { timestamps: true },
);

let ParentModel: Awaited<ReturnType<typeof createTestModel>>;
let ChildModel: Awaited<ReturnType<typeof createTestModel>>;

beforeAll(async () => {
  await connectDB();
  ParentModel = await createTestModel('ChunkParent', parentSchema);
  ChildModel = await createTestModel('ChunkChild', childSchema);
});

afterAll(async () => {
  await disconnectDB();
});

beforeEach(async () => {
  await ParentModel.deleteMany({});
  await ChildModel.deleteMany({});
});

const childRepo = () => new Repository(ChildModel as never, [methodRegistryPlugin()]);

async function seedParents(): Promise<Types.ObjectId[]> {
  const docs = await ParentModel.insertMany(
    Array.from({ length: PARENTS }, (_, i) => ({ name: `p${i}` })),
  );
  return docs.map((d) => d._id as Types.ObjectId);
}

/** Attach children to the FIRST and LAST parent — different slices at BATCH=25, n=60. */
async function seedCrossSliceChildren(parentIds: Types.ObjectId[]): Promise<void> {
  await ChildModel.create({ label: 'first-slice', parent: parentIds[0] });
  await ChildModel.create({ label: 'last-slice', parent: parentIds[PARENTS - 1] });
}

describe('idChunks (unit)', () => {
  it('yields nothing for an empty array', () => {
    expect([...idChunks([], 10)]).toEqual([]);
  });

  it('splits an exact multiple into equal slices', () => {
    const chunks = [...idChunks([1, 2, 3, 4], 2)];
    expect(chunks).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('puts the remainder in the final slice', () => {
    const chunks = [...idChunks([1, 2, 3, 4, 5], 2)];
    expect(chunks.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(chunks.flat()).toEqual([1, 2, 3, 4, 5]);
  });

  it('refuses a non-positive or fractional size', () => {
    expect(() => [...idChunks([1], 0)]).toThrow(/positive integer/);
    expect(() => [...idChunks([1], 2.5)]).toThrow(/positive integer/);
  });
});

describe('collectIds (unit)', () => {
  it('returns every matching id and only matching ids', async () => {
    const ids = await seedParents();
    const collected = await collectIds(ParentModel as never, { name: { $ne: 'p0' } });
    expect(collected).toHaveLength(PARENTS - 1);
    expect(collected.map(String)).not.toContain(String(ids[0]));
  });
});

describe('keyset primitives (unit)', () => {
  it('keysetFilter: null cursor returns the base filter; a cursor merges $gt without mutating', () => {
    const base = { tenant: 't1' };
    expect(keysetFilter(base, null)).toBe(base);
    const progressed = keysetFilter(base, 'abc');
    expect(progressed).toEqual({ tenant: 't1', _id: { $gt: 'abc' } });
    expect(base).toEqual({ tenant: 't1' }); // untouched
  });

  it('narrowToIds: re-asserts the base predicate beside the $in without mutating', () => {
    const base = { tenant: 't1' };
    expect(narrowToIds(base, [1, 2])).toEqual({ tenant: 't1', _id: { $in: [1, 2] } });
    expect(base).toEqual({ tenant: 't1' });
  });

  it('selectKeysetChunk: _id-ascending, limit respected, projection honoured', async () => {
    await seedParents();
    const chunk = (await selectKeysetChunk(ParentModel as never, {}, 10, {
      projection: { _id: 1 },
    })) as Array<{ _id: Types.ObjectId; name?: string }>;
    expect(chunk).toHaveLength(10);
    expect(chunk[0]!.name).toBeUndefined(); // projection applied
    const sorted = [...chunk].sort((a, b) => String(a._id).localeCompare(String(b._id)));
    expect(chunk.map((d) => String(d._id))).toEqual(sorted.map((d) => String(d._id)));

    // Progressing past the chunk's last id yields the NEXT rows, no overlap.
    const next = (await selectKeysetChunk(
      ParentModel as never,
      keysetFilter({}, chunk[chunk.length - 1]!._id),
      10,
      { projection: { _id: 1 } },
    )) as Array<{ _id: Types.ObjectId }>;
    expect(next).toHaveLength(10);
    const firstIds = new Set(chunk.map((d) => String(d._id)));
    for (const doc of next) expect(firstIds.has(String(doc._id))).toBe(false);
  });
});

describe('bulk restrict — sliced counts, summed across slices', () => {
  it('refuses with the TRUE total when blockers sit in DIFFERENT slices', async () => {
    const parentIds = await seedParents();
    await seedCrossSliceChildren(parentIds);

    const target = childRepo();
    const repo = new Repository(ParentModel as never, [
      methodRegistryPlugin(),
      cascadePlugin({
        batchSize: BATCH,
        relations: [{ repo: target as never, foreignKey: 'parent', onDelete: 'restrict' }],
      }),
    ]);

    let thrown: (Error & { code?: string; details?: { count?: number } }) | undefined;
    await repo.deleteMany({ name: { $regex: /^p/ } }).catch((e: Error) => {
      thrown = e as never;
    });

    expect(thrown?.code).toBe('REFERENCE_RESTRICTED');
    // count === 2 proves the counts were SUMMED across slices. A first-slice-only
    // implementation reports 1; an unsliced one can't be distinguished here — that's
    // what the spy test below is for.
    expect(thrown?.details?.count).toBe(2);
    expect(await ParentModel.countDocuments({})).toBe(PARENTS);
  });

  it('issues one count per slice, each $in bounded, ids covered exactly once', async () => {
    const parentIds = await seedParents();
    await seedCrossSliceChildren(parentIds);

    const target = childRepo();
    const countSpy = vi.spyOn(target as never as { count: (...a: unknown[]) => Promise<number> }, 'count');

    const repo = new Repository(ParentModel as never, [
      methodRegistryPlugin(),
      cascadePlugin({
        batchSize: BATCH,
        relations: [{ repo: target as never, foreignKey: 'parent', onDelete: 'restrict' }],
      }),
    ]);

    await repo.deleteMany({ name: { $regex: /^p/ } }).catch(() => {});

    // Denominators: ceil(60/25) = 3 calls, no $in longer than BATCH, and the union of
    // all slices is exactly the parent set (nothing dropped, nothing duplicated).
    expect(countSpy).toHaveBeenCalledTimes(3);
    const seen: string[] = [];
    for (const call of countSpy.mock.calls) {
      const inList = (call[0] as { parent: { $in: unknown[] } }).parent.$in;
      expect(inList.length).toBeLessThanOrEqual(BATCH);
      seen.push(...inList.map(String));
    }
    expect(new Set(seen).size).toBe(PARENTS);
    expect(seen).toHaveLength(PARENTS);
  });
});

describe('bulk detach — every slice detached', () => {
  it('unsets the reference on children of parents in DIFFERENT slices', async () => {
    const parentIds = await seedParents();
    await seedCrossSliceChildren(parentIds);

    const repo = new Repository(ParentModel as never, [
      methodRegistryPlugin(),
      cascadePlugin({
        batchSize: BATCH,
        relations: [{ repo: childRepo() as never, foreignKey: 'parent', onDelete: 'detach' }],
      }),
    ]);

    await repo.deleteMany({ name: { $regex: /^p/ } });

    expect(await ParentModel.countDocuments({})).toBe(0);
    // Both children survive with the reference cleared — a slicing bug that skipped the
    // final partial slice would leave 'last-slice' still pointing at a dead parent.
    expect(await ChildModel.countDocuments({})).toBe(2);
    expect(await ChildModel.countDocuments({ parent: { $exists: true } })).toBe(0);
  });
});

describe('bulk cascade — every slice deleted, each call bounded', () => {
  it('deletes children across slices and never issues an $in past batchSize', async () => {
    const parentIds = await seedParents();
    await seedCrossSliceChildren(parentIds);

    const target = childRepo();
    const delSpy = vi.spyOn(
      target as never as { deleteMany: (...a: unknown[]) => Promise<unknown> },
      'deleteMany',
    );

    const repo = new Repository(ParentModel as never, [
      methodRegistryPlugin(),
      cascadePlugin({
        batchSize: BATCH,
        relations: [{ repo: target as never, foreignKey: 'parent' }], // default = cascade
      }),
    ]);

    await repo.deleteMany({ name: { $regex: /^p/ } });

    expect(await ParentModel.countDocuments({})).toBe(0);
    expect(await ChildModel.countDocuments({})).toBe(0);

    expect(delSpy).toHaveBeenCalledTimes(3);
    for (const call of delSpy.mock.calls) {
      const inList = (call[0] as { parent: { $in: unknown[] } }).parent.$in;
      expect(inList.length).toBeLessThanOrEqual(BATCH);
    }
  });
});

describe('batchSize config', () => {
  it('defaults to a single call when the match fits one slice', async () => {
    await seedParents();

    const target = childRepo();
    const countSpy = vi.spyOn(target as never as { count: (...a: unknown[]) => Promise<number> }, 'count');

    const repo = new Repository(ParentModel as never, [
      methodRegistryPlugin(),
      // no batchSize → DEFAULT_ID_CHUNK (10k) — 60 parents fit in one slice
      cascadePlugin({
        relations: [{ repo: target as never, foreignKey: 'parent', onDelete: 'restrict' }],
      }),
    ]);

    await repo.deleteMany({ name: { $regex: /^p/ } });
    expect(countSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a nonsense batchSize at construction', () => {
    expect(() =>
      cascadePlugin({
        batchSize: 0,
        relations: [{ repo: childRepo() as never, foreignKey: 'parent' }],
      }),
    ).toThrow(/positive integer/);
  });
});
