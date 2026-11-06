/**
 * Mongokit's Better Auth helpers against the REAL Better Auth mongo adapter, with the pulled reference
 * behaviour observed rather than assumed:
 *
 *   1. The adapter creates the indexes a plugin declares at table level (device-authorization:
 *      unique `deviceCode` and `userCode`) on first use of the model, under its own names.
 *      `ensureBetterAuthIndexes` must not add a second, redundant index on the same keys,
 *      whichever side ran first.
 *   2. `generateId: 'uuid'` stores real BSON UUIDs; the overlay must resolve a row by its string id.
 *
 * Everything here runs in its OWN database, so it cannot disturb the other Better Auth test files
 * that share the default one in parallel.
 */

import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { betterAuth } from 'better-auth';
import { deviceAuthorization, organization } from 'better-auth/plugins';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBetterAuthOverlay, ensureBetterAuthIndexes } from '../../src/better-auth/index.js';
import type { Repository } from '../../src/Repository.js';
import { connectDB, disconnectDB } from '../setup.js';

const DB_NAME = `ba_coexist_${process.pid}`;
const ownDb = () => mongoose.connection.getClient().db(DB_NAME);
const ownConnection = () => mongoose.connection.useDb(DB_NAME, { useCache: true });

beforeAll(async () => {
  await connectDB();
});
afterAll(async () => {
  await ownDb()
    .dropDatabase()
    .catch(() => undefined);
  await disconnectDB();
});
afterEach(async () => {
  const conn = ownConnection();
  for (const name of Object.keys(conn.models)) conn.deleteModel(name);
  await ownDb()
    .dropDatabase()
    .catch(() => undefined);
});

async function deviceKeyIndexes() {
  const rows = await ownDb().collection('deviceCode').indexes();
  return rows.filter((i) => i.name !== '_id_' && !('expiresAt' in (i.key as object)));
}

const future = () => new Date(Date.now() + 60_000);

describe('deviceCode indexes: the adapter owns them, the kit must not duplicate them', () => {
  const baOptions = {
    secret: 'mongokit-better-auth-test-secret-32+chars',
    baseURL: 'http://test',
    plugins: [deviceAuthorization()],
  };

  it('adapter first, kit second: one unique index per key, no failure', async () => {
    const auth = betterAuth({ ...baOptions, database: mongodbAdapter(ownDb()) });
    const ctx = await auth.$context;
    await ctx.adapter.create({
      model: 'deviceCode',
      data: { deviceCode: 'dc-1', userCode: 'uc-1', expiresAt: future(), status: 'pending' },
    });

    const report = await ensureBetterAuthIndexes(ownDb(), { plugins: ['deviceAuthorization'] });
    expect(report.filter((r) => r.status === 'failed')).toEqual([]);

    const indexes = await deviceKeyIndexes();
    expect(indexes.filter((i) => 'deviceCode' in (i.key as object)).map((i) => i.unique)).toEqual([
      true,
    ]);
    expect(indexes.filter((i) => 'userCode' in (i.key as object)).map((i) => i.unique)).toEqual([
      true,
    ]);
  });

  it('kit first, adapter second: still one index per key, and a duplicate device code is refused', async () => {
    await ensureBetterAuthIndexes(ownDb(), { plugins: ['deviceAuthorization'] });
    const auth = betterAuth({ ...baOptions, database: mongodbAdapter(ownDb()) });
    const ctx = await auth.$context;
    await ctx.adapter.create({
      model: 'deviceCode',
      data: { deviceCode: 'dc-2', userCode: 'uc-2', expiresAt: future(), status: 'pending' },
    });

    const indexes = await deviceKeyIndexes();
    expect(indexes.filter((i) => 'deviceCode' in (i.key as object))).toHaveLength(1);
    await expect(
      ctx.adapter.create({
        model: 'deviceCode',
        data: { deviceCode: 'dc-2', userCode: 'uc-3', expiresAt: future(), status: 'pending' },
      }),
    ).rejects.toThrow();
  });
});

describe("generateId: 'uuid' (BSON UUID _id)", () => {
  it('the overlay resolves and updates a row by its string id', async () => {
    const auth = betterAuth({
      secret: 'mongokit-better-auth-test-secret-32+chars',
      baseURL: 'http://test',
      database: mongodbAdapter(ownDb()),
      advanced: { database: { generateId: 'uuid' } },
      plugins: [organization()],
    });
    const ctx = await auth.$context;
    const created = (await ctx.adapter.create({
      model: 'organization',
      data: { name: 'Acme', slug: 'acme-uuid', createdAt: new Date() },
    })) as { id: string };
    const raw = await ownDb().collection('organization').findOne({ slug: 'acme-uuid' });
    expect(raw?._id?.constructor?.name).toBe('UUID');

    const conn = ownConnection();
    const adapter = (await createBetterAuthOverlay({
      auth,
      mongoose: {
        Schema: mongoose.Schema,
        models: conn.models,
        model: conn.model.bind(conn),
      } as never,
      collection: 'organization',
      idType: 'uuid',
      unsafeWritable: true,
    })) as unknown as { repository: Repository<Record<string, unknown>> };
    const repo = adapter.repository;

    expect(await repo.getById(created.id, { throwOnNotFound: false } as never)).not.toBeNull();
    await repo.update(created.id, { name: 'Acme 2' } as never);
    const after = await ownDb().collection('organization').findOne({ slug: 'acme-uuid' });
    expect(after?.name).toBe('Acme 2');
  });
});
