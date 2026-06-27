/**
 * better-auth-id-resolution.test.ts
 *
 * Regression test for the overlay `getById` 404 (and the SAME latent bug in
 * `update` / `delete` / `populate`). Proven end-to-end against REAL Better Auth
 * (latest, see devDependencies) + the real `@better-auth/mongo-adapter`:
 *
 *   1. A doc CREATED BY BA's own mongo adapter gets an ObjectId `_id`
 *      (not a string). This is the fact the whole bug hinges on.
 *   2. With the FIXED stub schema (default `_id` SchemaType, i.e. NO
 *      `_id: false`), `Repository.getById/update/delete` resolve the doc by
 *      its hex-string id — Mongoose casts string -> ObjectId.
 *   3. Regression guard: a stub built WITH `_id: false` (the old behavior)
 *      removes the caster, so the SAME hex string queries `{ _id: "<string>" }`
 *      uncast and matches nothing — getById -> null, update -> no-op,
 *      delete -> no-op. That is exactly the production 404 / silent-no-op.
 *
 * This is the test the bug report demanded: "test by installing the latest
 * better auth in dev deps" — so the adapter behavior is observed, not assumed.
 */

import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createBetterAuthOverlay,
  registerBetterAuthStubs,
} from '../../src/better-auth/index.js';
import { Repository } from '../../src/Repository.js';
import { connectDB, disconnectDB } from '../setup.js';

beforeAll(async () => {
  await connectDB();
});

afterAll(async () => {
  await disconnectDB();
});

afterEach(async () => {
  for (const name of Object.keys(mongoose.models)) {
    mongoose.deleteModel(name);
  }
  for (const key in mongoose.connection.collections) {
    await mongoose.connection.collections[key]!.deleteMany({});
  }
});

/** Build a real betterAuth instance against the shared MongoMemoryServer. */
function createBA() {
  return betterAuth({
    secret: 'mongokit-better-auth-test-secret-32+chars',
    baseURL: 'http://test',
    database: mongodbAdapter(mongoose.connection.getClient().db()),
    emailAndPassword: { enabled: true },
    plugins: [organization()],
  });
}

describe('Better Auth id resolution (real adapter)', () => {
  it('BA mongo adapter stores ObjectId _ids (the bug premise)', async () => {
    const auth = createBA();
    const ctx = await auth.$context;

    // Create an org the way BA itself does — through its resolved adapter.
    const created = (await ctx.adapter.create({
      model: 'organization',
      data: { name: 'Acme', slug: 'acme', createdAt: new Date() },
    })) as { id: string };

    // Query by the unique slug — `findOne({})` is order-dependent and can pick
    // up an org left by another test sharing the fork's DB.
    const raw = await mongoose.connection.collection('organization').findOne({ slug: 'acme' });
    expect(raw).toBeTruthy();
    // The decisive assertion: BA's adapter persisted an ObjectId, not a string.
    expect(raw!._id).toBeInstanceOf(mongoose.Types.ObjectId);
    // BA's returned `id` is the hex string of that ObjectId.
    expect(String(raw!._id)).toBe(created.id);
  });

  it('overlay getById/update/delete resolve a BA-created org by hex id (FIXED schema)', async () => {
    const auth = createBA();
    const ctx = await auth.$context;
    const created = (await ctx.adapter.create({
      model: 'organization',
      data: { name: 'Beta', slug: 'beta', createdAt: new Date() },
    })) as { id: string };
    const hexId = created.id;

    // EXACT brihot path: host registers the stub first (auth.ts does this for
    // 'organization'), then the admin resource builds the overlay, which reuses
    // the already-registered stub model.
    registerBetterAuthStubs(mongoose, { plugins: ['organization'] });
    const adapter = (await createBetterAuthOverlay({
      auth,
      mongoose,
      collection: 'organization',
    })) as unknown as { repository: Repository<{ name: string }> };
    // arc drives CRUD through the adapter's repository — the layer that holds
    // the _id-cast logic the bug lived in.
    const repo = adapter.repository;

    // getById — the original 404.
    const got = (await repo.getById(hexId)) as { _id: unknown; name: string } | null;
    expect(got).toBeTruthy();
    expect(got!.name).toBe('Beta');

    // update — same _id-cast path; was a silent no-op under the bug.
    const updated = (await repo.update(hexId, { name: 'Beta 2' })) as { name: string } | null;
    expect(updated).toBeTruthy();
    expect(updated!.name).toBe('Beta 2');
    const afterUpdate = await mongoose.connection
      .collection('organization')
      .findOne({ _id: new mongoose.Types.ObjectId(hexId) });
    expect(afterUpdate!.name).toBe('Beta 2');

    // delete — same _id-cast path; was a silent no-op under the bug.
    await repo.delete(hexId);
    const afterDelete = await mongoose.connection
      .collection('organization')
      .findOne({ _id: new mongoose.Types.ObjectId(hexId) });
    expect(afterDelete).toBeNull();
  });

  it('REGRESSION GUARD: an `_id: false` stub reproduces the 404 / silent no-op', async () => {
    const auth = createBA();
    const ctx = await auth.$context;
    const created = (await ctx.adapter.create({
      model: 'organization',
      data: { name: 'Gamma', slug: 'gamma', createdAt: new Date() },
    })) as { id: string };
    const hexId = created.id;

    // Rebuild the OLD broken stub: `_id: false` strips the _id SchemaType, so
    // Mongoose has no caster for string -> ObjectId on _id queries.
    const brokenSchema = new mongoose.Schema(
      {},
      { strict: false, collection: 'organization', _id: false, timestamps: false },
    );
    const BrokenModel = mongoose.model('organization', brokenSchema);
    const brokenRepo = new Repository(BrokenModel as never);

    // All three _id-keyed ops fail to resolve the ObjectId doc by hex string.
    const got = await brokenRepo.getById(hexId).catch(() => null);
    expect(got).toBeNull();

    const updated = await brokenRepo.update(hexId, { name: 'nope' }).catch(() => null);
    expect(updated).toBeNull();
    const stillThere = await mongoose.connection
      .collection('organization')
      .findOne({ _id: new mongoose.Types.ObjectId(hexId) });
    expect(stillThere!.name).toBe('Gamma'); // update was a no-op — doc untouched
  });
});
