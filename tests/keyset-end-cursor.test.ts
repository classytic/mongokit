/**
 * `end` — the cursor at a keyset page's last row, minted even when `next` is null. A change
 * feed walks to its end, stores `end`, and later resumes from it to read ONLY what changed
 * since; without it the caught-up caller has no position and must re-read everything.
 */

import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../src/index.js';
import { connectDB, disconnectDB } from './setup.js';

interface IItem {
  _id: Types.ObjectId;
  name: string;
  updatedAt: Date;
}

const ItemSchema = new Schema<IItem>({ name: String, updatedAt: { type: Date, required: true } });
ItemSchema.index({ updatedAt: 1, _id: 1 });

describe('keyset `end` cursor', () => {
  let repo: Repository<IItem>;
  let Model: mongoose.Model<IItem>;
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
  const feed = (after?: string) =>
    repo.getAll({ sort: { updatedAt: 1, _id: 1 }, limit: 2, mode: 'keyset', ...(after ? { after } : {}) }) as Promise<{
      data: IItem[];
      next: string | null;
      hasMore: boolean;
      end?: string | null;
    }>;

  beforeAll(async () => {
    await connectDB();
    if (mongoose.models.KeysetEndItem) delete mongoose.models.KeysetEndItem;
    Model = mongoose.model<IItem>('KeysetEndItem', ItemSchema);
    repo = new Repository(Model);
  });
  afterAll(disconnectDB);
  beforeEach(async () => {
    await Model.deleteMany({});
    await Model.insertMany([1, 2, 3].map((s) => ({ name: `i${s}`, updatedAt: at(s) })));
  });

  it('mints `end` on the last page, where `next` is null', async () => {
    const first = await feed();
    expect(first.hasMore).toBe(true);
    const last = await feed(first.next!);
    expect(last.data.map((d) => d.name)).toEqual(['i3']);
    expect(last.next).toBeNull();
    expect(last.end).toEqual(expect.any(String));
  });

  it('resuming from `end` reads only rows added after it', async () => {
    let page = await feed();
    while (page.hasMore) page = await feed(page.next!);
    const resume = page.end!;
    expect((await feed(resume)).data).toEqual([]);

    await Model.create({ name: 'i4', updatedAt: at(4) });
    expect((await feed(resume)).data.map((d) => d.name)).toEqual(['i4']);
  });

  it('an empty page has `end: null`', async () => {
    await Model.deleteMany({});
    expect((await feed()).end).toBeNull();
  });
});
