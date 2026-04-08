/**
 * E2E: String/UUID/Number _id through the full mongokit pipeline
 *
 * Exercises every layer in sequence:
 *   1. Schema generation → create body must include _id as the right type
 *   2. QueryParser → ?_id=uuid must coerce correctly (not to number/objectid)
 *   3. Repository.create → generates _id via the schema default
 *   4. Repository.getById → finds by the generated _id
 *   5. Repository.getAll with filter → ?_id=uuid finds the doc
 *   6. Repository.update / delete → work with the non-ObjectId _id
 *
 * If any layer breaks the contract, the pipeline fails end-to-end.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Document, Schema } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCrudSchemasFromModel,
  QueryParser,
} from '../src/index.js';
import Repository from '../src/Repository.js';
import { getSchemaIdType } from '../src/utils/id-resolution.js';

// ── String _id (UUID) ────────────────────────────────────────────────────

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
let parser: QueryParser;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  SessionModel = mongoose.model<ISession>('E2EStringIdSession', SessionSchema);
  repo = new Repository(SessionModel);
  parser = new QueryParser({ schema: SessionSchema });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await SessionModel.deleteMany({});
});

describe('E2E pipeline: String _id (UUID)', () => {
  // ── Layer 0: id-resolution primitive ──────────────────────────────────

  it('getSchemaIdType detects string _id', () => {
    expect(getSchemaIdType(SessionSchema)).toBe('string');
  });

  // ── Layer 1: Schema generation ────────────────────────────────────────

  it('buildCrudSchemasFromModel includes String _id in createBody as optional', () => {
    const schemas = buildCrudSchemasFromModel(SessionModel);
    // When _id is explicitly declared as String (not the default ObjectId),
    // the createBody should include it so users can supply their own UUID.
    // It should be optional (the schema default generates one).
    const idProp = schemas.createBody.properties?._id as
      | { type: string }
      | undefined;
    expect(idProp).toBeDefined();
    expect(idProp!.type).toBe('string');
    // Must NOT be required — the schema default handles it
    const required = (schemas.createBody.required as string[]) ?? [];
    expect(required).not.toContain('_id');
  });

  // ── Layer 2: QueryParser coercion ─────────────────────────────────────

  it('QueryParser preserves UUID _id as string (does not coerce to number or objectid)', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const parsed = parser.parse({ _id: uuid });
    expect(parsed.filters._id).toBe(uuid);
    expect(typeof parsed.filters._id).toBe('string');
  });

  it('QueryParser preserves UUID in operator syntax (?_id[in]=uuid1,uuid2)', () => {
    const uuid1 = randomUUID();
    const uuid2 = randomUUID();
    const parsed = parser.parse({ '_id[in]': `${uuid1},${uuid2}` });
    const inArray = (parsed.filters._id as { $in: string[] }).$in;
    expect(inArray).toEqual([uuid1, uuid2]);
    // Both must be strings, not coerced
    expect(typeof inArray[0]).toBe('string');
  });

  // ── Layer 3–6: Repository CRUD with UUID _id ──────────────────────────

  it('create → getById → getAll → update → delete full lifecycle', async () => {
    // Create
    const created = await repo.create({
      userId: 'user-1',
      token: 'abc',
    } as Partial<ISession>);
    const createdId = created._id as string;
    expect(createdId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // getById
    const fetched = await repo.getById(createdId);
    expect(fetched).not.toBeNull();
    expect(fetched!.token).toBe('abc');

    // getAll with parsed filter
    const parsed = parser.parse({ _id: createdId });
    const listResult = await repo.getAll({
      filters: parsed.filters,
      mode: 'offset',
    });
    if (listResult.method !== 'offset') throw new Error('expected offset');
    expect(listResult.total).toBe(1);
    expect(listResult.docs[0]._id).toBe(createdId);

    // update
    const updated = await repo.update(createdId, { token: 'xyz' });
    expect(updated.token).toBe('xyz');

    // delete
    const deleteResult = await repo.delete(createdId);
    expect(deleteResult.success).toBe(true);

    // verify deleted
    const afterDelete = await repo.getById(createdId, { throwOnNotFound: false });
    expect(afterDelete).toBeNull();
  });

  it('getAll with $in filter on UUID _ids returns matching docs', async () => {
    const docs = await SessionModel.insertMany([
      { _id: randomUUID(), userId: 'user-1', token: 'a' },
      { _id: randomUUID(), userId: 'user-2', token: 'b' },
      { _id: randomUUID(), userId: 'user-3', token: 'c' },
    ]);

    const parsed = parser.parse({
      '_id[in]': `${docs[0]._id},${docs[2]._id}`,
    });
    const result = await repo.getAll({
      filters: parsed.filters,
      mode: 'offset',
    });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(2);
    const ids = result.docs.map((d) => d._id).sort();
    expect(ids).toEqual([docs[0]._id, docs[2]._id].sort());
  });
});
