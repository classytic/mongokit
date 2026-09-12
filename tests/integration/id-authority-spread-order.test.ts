/**
 * `update()` / `delete()` — the positional id is the authority over any
 * `query` constraint riding the options bag.
 *
 * Regression for the spread order in `actions/update.ts` and
 * `actions/delete.ts`: `{ _id: id, ...query }` let a `query._id` REPLACE the
 * positional id and retarget the write to another document. The documented
 * rule (see `Repository.update`'s CAS branch) is "injected scope FIRST,
 * caller authority LAST" — scope may only narrow the match.
 */

import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IDoc {
  _id: mongoose.Types.ObjectId;
  name: string;
}

describe('update/delete — positional id wins over options.query._id', () => {
  let Model: mongoose.Model<IDoc>;
  let repo: Repository<IDoc>;
  let a: IDoc;
  let b: IDoc;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'IdAuthorityDoc',
      new Schema<IDoc>({ name: { type: String, required: true } }),
    );
    repo = new Repository<IDoc>(Model);
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });
  beforeEach(async () => {
    await Model.deleteMany({});
    [a, b] = await Model.create([{ name: 'a' }, { name: 'b' }]);
  });

  it('update() targets the positional id even when options.query carries another _id', async () => {
    const result = await repo.update(String(a._id), { name: 'a2' }, { query: { _id: b._id } });

    expect(result?.name).toBe('a2');
    expect(String(result?._id)).toBe(String(a._id));
    expect((await Model.findById(b._id).lean())?.name).toBe('b');
  });

  it('update() still lets options.query NARROW the match', async () => {
    // Scope that excludes the target → miss, not a retarget.
    const result = await repo.update(String(a._id), { name: 'a2' }, { query: { name: 'nope' } });
    expect(result).toBeNull();
    expect((await Model.findById(a._id).lean())?.name).toBe('a');
  });

  it('delete() targets the positional id even when options.query carries another _id', async () => {
    // `query` is a hook-supplied slot, not part of delete's typed bag — a
    // JS caller (or a plugin writing `context.query`) can still set it.
    const result = await repo.delete(String(a._id), {
      query: { _id: b._id },
    } as Parameters<Repository<IDoc>['delete']>[1]);

    expect(result?.id).toBe(String(a._id));
    expect(await Model.findById(a._id).lean()).toBeNull();
    expect((await Model.findById(b._id).lean())?.name).toBe('b');
  });
});
