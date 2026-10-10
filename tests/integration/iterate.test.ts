/**
 * `iterate(filter, { after, batchSize, maxTimeMS, select })`: resumable keyset batches over `_id`.
 * Each batch is its own bounded `find` (no getMore, no long-lived cursor), every batch carries a
 * checkpoint, resuming yields no duplicate and no gap under concurrent writes, and a checkpoint
 * from another scope is refused.
 */

import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { multiTenantPlugin, PAGINATION_ERROR_CODES, Repository } from '../../src/index.js';
import { recordCommands } from '../../src/testkit/index.js';
import { connectDB, getMongoUri } from '../setup.js';

interface IRow {
  organizationId: string;
  n: number;
}

describe('iterate', () => {
  let conn: Connection;
  let Row: Model<IRow>;
  let repo: Repository<IRow>;

  beforeAll(async () => {
    await connectDB();
    conn = await mongoose.createConnection(getMongoUri(), { monitorCommands: true }).asPromise();
    Row = conn.model<IRow>('IterateRow', new Schema<IRow>({ organizationId: String, n: Number }));
    await Row.init();
    repo = new Repository<IRow>(Row, [multiTenantPlugin({ tenantField: 'organizationId' })]);
  });
  afterAll(async () => {
    await Row.deleteMany({});
    await conn.close();
  });
  beforeEach(async () => {
    await Row.deleteMany({});
    await Row.insertMany([
      ...Array.from({ length: 25 }, (_, n) => ({ organizationId: 'org-a', n })),
      ...Array.from({ length: 5 }, (_, n) => ({ organizationId: 'org-b', n })),
    ]);
  });

  const drain = async (it: AsyncIterable<{ docs: IRow[]; checkpoint: string }>) => {
    const out: { docs: IRow[]; checkpoint: string }[] = [];
    for await (const batch of it) out.push(batch);
    return out;
  };

  it('yields every scoped row once, in bounded batches, one find each, no getMore', async () => {
    const { result, commands } = await recordCommands(conn, () =>
      drain(repo.iterate({}, { batchSize: 10, organizationId: 'org-a' })),
    );
    expect(result.map((b) => b.docs.length)).toEqual([10, 10, 5]);
    expect(new Set(result.flatMap((b) => b.docs.map((d) => d.n))).size).toBe(25);
    const finds = commands.filter((c) => c.name === 'find' && c.collection === Row.collection.collectionName);
    expect(finds).toHaveLength(3);
    for (const f of finds) expect(f.command.limit).toBe(10);
    expect(commands.filter((c) => c.name === 'getMore')).toHaveLength(0);
  });

  it('resumes from a checkpoint with no duplicate and no gap under concurrent writes', async () => {
    const first: IRow[] = [];
    let checkpoint = '';
    for await (const batch of repo.iterate({}, { batchSize: 8, organizationId: 'org-a' })) {
      first.push(...batch.docs);
      checkpoint = batch.checkpoint;
      break;
    }
    // Concurrent writes: a delete ahead of the checkpoint, inserts after it.
    await Row.deleteOne({ organizationId: 'org-a', n: 20 });
    await Row.insertMany([
      { organizationId: 'org-a', n: 100 },
      { organizationId: 'org-a', n: 101 },
    ]);
    const rest = (await drain(repo.iterate({}, { batchSize: 8, after: checkpoint, organizationId: 'org-a' }))).flatMap(
      (b) => b.docs,
    );
    const all = [...first, ...rest].map((d) => d.n);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort((a, b) => a - b)).toEqual([...Array.from({ length: 25 }, (_, n) => n).filter((n) => n !== 20), 100, 101]);
  });

  it('a checkpoint is refused for another tenant or filter', async () => {
    let checkpoint = '';
    for await (const batch of repo.iterate({}, { batchSize: 5, organizationId: 'org-a' })) {
      checkpoint = batch.checkpoint;
      break;
    }
    await expect(drain(repo.iterate({}, { after: checkpoint, organizationId: 'org-b' }))).rejects.toMatchObject({
      code: PAGINATION_ERROR_CODES.CURSOR_SCOPE_MISMATCH,
    });
    await expect(
      drain(repo.iterate({ n: { $gt: 3 } }, { after: checkpoint, organizationId: 'org-a' })),
    ).rejects.toMatchObject({ code: PAGINATION_ERROR_CODES.CURSOR_SCOPE_MISMATCH });
  });

  it('every batch carries the time bound, and select keeps _id', async () => {
    const { result, commands } = await recordCommands(conn, () =>
      drain(repo.iterate({}, { batchSize: 30, maxTimeMS: 2500, select: 'n', organizationId: 'org-a' })),
    );
    const find = commands.find((c) => c.name === 'find');
    expect(find?.command.maxTimeMS).toBeLessThanOrEqual(2500);
    expect(find?.command.maxTimeMS).toBeGreaterThan(1500);
    expect(result[0]?.docs[0]).toHaveProperty('_id');
    expect(result[0]?.docs[0]).not.toHaveProperty('organizationId');
  });

  it('a nonsense batch size is refused', async () => {
    await expect(drain(repo.iterate({}, { batchSize: 0, organizationId: 'org-a' }))).rejects.toThrow(/batchSize/);
  });
});
