/**
 * Repository with String _id (UUIDs, ULIDs, custom IDs)
 *
 * Proves that Repository.getById / update / delete work when the schema
 * declares `_id: String` instead of the default ObjectId. The original bug:
 * Repository hardcodes `mongoose.Types.ObjectId.isValid(id)` which rejects
 * any non-hex-24 string — including UUIDs — before the query even runs.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Document, Schema } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Repository from '../src/Repository.js';

interface ISession extends Document {
  _id: string;
  userId: string;
  token: string;
}

const SessionSchema = new Schema<ISession>({
  _id: { type: String, default: () => randomUUID() },
  userId: { type: String, required: true },
  token: { type: String, required: true },
});

let mongoServer: MongoMemoryServer;
let SessionModel: mongoose.Model<ISession>;
let repo: Repository<ISession>;

let uuid1: string;
let uuid2: string;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  SessionModel = mongoose.model<ISession>('StringIdSession', SessionSchema);
  repo = new Repository(SessionModel);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await SessionModel.deleteMany({});
  const docs = await SessionModel.insertMany([
    { _id: randomUUID(), userId: 'user-1', token: 'abc' },
    { _id: randomUUID(), userId: 'user-2', token: 'def' },
  ]);
  uuid1 = docs[0]._id as string;
  uuid2 = docs[1]._id as string;
});

describe('Repository with String _id (UUID)', () => {
  it('getById finds a document by UUID string', async () => {
    const doc = await repo.getById(uuid1);
    expect(doc).not.toBeNull();
    expect(doc!.userId).toBe('user-1');
  });

  it('getById returns null for a valid-format UUID that does not exist', async () => {
    const doc = await repo.getById(randomUUID(), { throwOnNotFound: false });
    expect(doc).toBeNull();
  });

  it('getById returns null for a non-existent UUID (MinimalRepo contract)', async () => {
    const result = await repo.getById(randomUUID());
    expect(result).toBeNull();
  });

  it('getById throws 404 with throwOnNotFound:true (legacy opt-in)', async () => {
    await expect(
      repo.getById(randomUUID(), { throwOnNotFound: true }),
    ).rejects.toThrow(/not found/i);
  });

  it('update modifies and returns the document by UUID', async () => {
    const updated = await repo.update(uuid1, { token: 'xyz' });
    expect(updated).not.toBeNull();
    expect(updated!.token).toBe('xyz');
    expect(updated!._id).toBe(uuid1);
  });

  it('delete removes the document by UUID', async () => {
    await repo.delete(uuid1);
    const doc = await repo.getById(uuid1, { throwOnNotFound: false });
    expect(doc).toBeNull();
  });

  it('getAll still works and returns both UUID docs', async () => {
    const result = await repo.getAll({ mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(2);
  });

  it('create generates a UUID _id automatically', async () => {
    const doc = await repo.create({ userId: 'user-3', token: 'ghi' } as Partial<ISession>);
    expect(doc._id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

// Also test Number _id as a regression guard

interface ICounter extends Document {
  _id: number;
  label: string;
}

const CounterSchema = new Schema<ICounter>({
  _id: { type: Number },
  label: { type: String, required: true },
});

describe('Repository with Number _id', () => {
  let CounterModel: mongoose.Model<ICounter>;
  let counterRepo: Repository<ICounter>;

  beforeAll(async () => {
    CounterModel = mongoose.model<ICounter>('NumberIdCounter', CounterSchema);
    counterRepo = new Repository(CounterModel);
  });

  beforeEach(async () => {
    await CounterModel.deleteMany({});
    await CounterModel.insertMany([
      { _id: 1, label: 'first' },
      { _id: 2, label: 'second' },
    ]);
  });

  it('getById finds by numeric _id', async () => {
    const doc = await counterRepo.getById(1 as unknown as string);
    expect(doc).not.toBeNull();
    expect(doc!.label).toBe('first');
  });

  it('update works by numeric _id', async () => {
    const updated = await counterRepo.update(1 as unknown as string, { label: 'updated' });
    expect(updated).not.toBeNull();
    expect(updated!.label).toBe('updated');
  });
});
