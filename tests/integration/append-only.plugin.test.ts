/**
 * `appendOnlyPlugin()` — immutable-facts fence derived from
 * OP_REGISTRY: inserts land, every other mutating op is refused at
 * POLICY priority, with an audited per-call bypass and a plugin-level
 * `allow` list for a domain's one legitimate mutation path.
 */

import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendOnlyPlugin, Repository } from '../../src/index.js';
import { methodRegistryPlugin } from '../../src/plugins/method-registry.plugin.js';
import { mongoOperationsPlugin } from '../../src/plugins/mongo-operations.plugin.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IEvent {
  _id?: mongoose.Types.ObjectId;
  type: string;
  occurredAt: Date;
}

describe('appendOnlyPlugin — immutable-facts fence', () => {
  let EventModel: mongoose.Model<IEvent>;
  let repo: Repository<IEvent>;

  beforeAll(async () => {
    await connectDB();
    EventModel = await createTestModel(
      'AppendOnlyEvent',
      new Schema<IEvent>({
        type: { type: String, required: true },
        occurredAt: { type: Date, required: true },
      }),
    );
    repo = new Repository<IEvent>(EventModel, [appendOnlyPlugin()]);
  });
  afterAll(async () => {
    await disconnectDB();
  });

  const row = () => ({ type: 'x.happened', occurredAt: new Date() });

  it('appends land: create + createMany', async () => {
    const one = await repo.create(row());
    expect(one.type).toBe('x.happened');
    const many = await repo.createMany([row(), row()]);
    expect(many).toHaveLength(2);
  });

  it('refuses every non-append mutation with 405 APPEND_ONLY_VIOLATION', async () => {
    const doc = await repo.create(row());
    const id = String(doc._id);
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['update', () => repo.update(id, { type: 'mutated' })],
      ['delete', () => repo.delete(id)],
      ['updateMany', () => repo.updateMany({ type: 'x.happened' }, { $set: { type: 'y' } })],
      ['deleteMany', () => repo.deleteMany({ type: 'x.happened' })],
      ['findOneAndUpdate', () => repo.findOneAndUpdate({ _id: id }, { $set: { type: 'y' } })],
      ['claim', () => repo.claim(id, { field: 'type', from: 'x.happened', to: 'y' })],
    ];
    for (const [op, fn] of attempts) {
      const err = (await fn().catch((e: unknown) => e)) as Error & {
        status?: number;
        code?: string;
      };
      expect(err.status, `${op} should be refused`).toBe(405);
      expect(err.code, `${op} code`).toBe('APPEND_ONLY_VIOLATION');
    }
    // Rows untouched.
    const fresh = await repo.getById(id);
    expect(fresh!.type).toBe('x.happened');
  });

  it('per-call bypass works and emits the audit event', async () => {
    const doc = await repo.create(row());
    const bypasses: unknown[] = [];
    repo.on('after:append-only-bypass', (ctx: unknown) => {
      bypasses.push(ctx);
    });
    const updated = await repo.update(String(doc._id), { type: 'repaired' }, {
      bypassAppendOnly: true,
    } as never);
    expect(updated!.type).toBe('repaired');
    expect(bypasses).toHaveLength(1);
    expect((bypasses[0] as { operation: string }).operation).toBe('update');
  });

  it('fences COMPOSED methods too — incrementIfBelow decomposes to findOneAndUpdate', async () => {
    const ComposedModel = await createTestModel(
      'AppendOnlyComposed',
      new Schema<IEvent & { seq?: number }>({
        type: { type: String, required: true },
        occurredAt: { type: Date, required: true },
        seq: Number,
      }),
    );
    const composed = new Repository<IEvent & { seq?: number }>(ComposedModel, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
      appendOnlyPlugin(),
    ]);
    const doc = await composed.create({ ...row(), seq: 0 });
    const err = (await (
      composed as unknown as {
        incrementIfBelow(id: string, field: string, ceiling: number): Promise<unknown>;
      }
    )
      .incrementIfBelow(String(doc._id), 'seq', 10)
      .catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe('APPEND_ONLY_VIOLATION');
  });

  it('plugin-level allow list permits the named op only', async () => {
    const AllowModel = await createTestModel(
      'AppendOnlyAllowEvent',
      new Schema<IEvent>({
        type: { type: String, required: true },
        occurredAt: { type: Date, required: true },
      }),
    );
    const gdprRepo = new Repository<IEvent>(AllowModel, [
      appendOnlyPlugin({ allow: ['deleteMany'] }),
    ]);
    await gdprRepo.createMany([row(), row()]);
    const res = await gdprRepo.deleteMany({ type: 'x.happened' }, { mode: 'hard' } as never);
    expect(res).toBeTruthy();
    // Other mutations still refused.
    const doc = await gdprRepo.create(row());
    const err = (await gdprRepo
      .update(String(doc._id), { type: 'y' })
      .catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe('APPEND_ONLY_VIOLATION');
  });
});
