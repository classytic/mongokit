/**
 * Integration tests for `@classytic/mongokit/better-auth`.
 *
 * Exercises the BA × Mongoose overlay against a REAL `betterAuth()`
 * instance (with mongo-adapter over MongoMemoryServer) so the tests
 * validate the actual `auth.$context.tables` shape that the factory
 * depends on. Mocked `$context` would drift; the real instance keeps
 * the kit honest across BA upgrades.
 *
 * Coverage:
 *   1. `registerBetterAuthStubs` registration semantics
 *   2. `createBetterAuthOverlay` reads BA's resolved schema correctly
 *   3. additionalFields / modelName overrides flow through
 *   4. Multi-plugin schemas (organization, twoFactor) are picked up
 *   5. Throws on unknown collection / on stub conflict
 *   6. CRUD round-trip — BA writes, arc reads via the overlay
 */

import { apiKey } from '@better-auth/api-key';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { betterAuth } from 'better-auth';
import { admin, organization, twoFactor } from 'better-auth/plugins';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBetterAuthOverlay, registerBetterAuthStubs } from '../../src/better-auth/index.js';
import { connectDB, disconnectDB } from '../setup.js';

beforeAll(async () => {
  await connectDB();
});

afterAll(async () => {
  await disconnectDB();
});

afterEach(async () => {
  // Clean models + collections so each test starts fresh.
  for (const name of Object.keys(mongoose.models)) {
    mongoose.deleteModel(name);
  }
  for (const key in mongoose.connection.collections) {
    await mongoose.connection.collections[key]!.deleteMany({});
  }
});

/** Build a real betterAuth instance against the shared MongoMemoryServer. */
function createBA(plugins: ReturnType<typeof organization>[] = []) {
  return betterAuth({
    secret: 'mongokit-better-auth-test-secret-32+chars',
    baseURL: 'http://test',
    database: mongodbAdapter(mongoose.connection.getClient().db()),
    emailAndPassword: { enabled: true },
    plugins,
  });
}

// ============================================================================
// registerBetterAuthStubs — bulk registration
// ============================================================================

describe('registerBetterAuthStubs', () => {
  it('registers core models when no plugins are passed', () => {
    const registered = registerBetterAuthStubs(mongoose);
    expect(registered).toEqual(
      expect.arrayContaining(['user', 'session', 'account', 'verification']),
    );
    expect(registered).not.toContain('organization');
  });

  it('registers organization-set when plugins includes "organization"', () => {
    const registered = registerBetterAuthStubs(mongoose, { plugins: ['organization'] });
    expect(registered).toEqual(expect.arrayContaining(['organization', 'member', 'invitation']));
  });

  it('is idempotent — second call returns []', () => {
    registerBetterAuthStubs(mongoose);
    const second = registerBetterAuthStubs(mongoose);
    expect(second).toEqual([]);
  });

  it('honors usePlural by appending s', () => {
    const registered = registerBetterAuthStubs(mongoose, {
      plugins: ['organization'],
      usePlural: true,
    });
    expect(registered).toContain('users');
    expect(registered).toContain('organizations');
    expect(registered).not.toContain('user');
  });

  it('respects modelOverrides for custom BA modelName mappings', () => {
    const registered = registerBetterAuthStubs(mongoose, {
      plugins: ['organization'],
      modelOverrides: { user: 'profile', member: 'orgMember' },
    });
    expect(registered).toContain('profile');
    expect(registered).toContain('orgMember');
    expect(registered).not.toContain('user');
  });

  it('registers stubs with strict: false so any BA document round-trips', async () => {
    registerBetterAuthStubs(mongoose);
    const UserModel = mongoose.models.user as mongoose.Model<Record<string, unknown>>;
    await UserModel.create({
      _id: 'usr_abc' as unknown as never,
      email: 'a@b.io',
      role: 'admin,recruiter',
      // not declared — should still persist via strict: false
      customField: 'x',
    });
    const found = await UserModel.findById('usr_abc' as unknown as never).lean();
    expect(found).toMatchObject({ email: 'a@b.io', customField: 'x' });
  });
});

// ============================================================================
// createBetterAuthOverlay — async factory using real auth.$context
// ============================================================================

describe('createBetterAuthOverlay', () => {
  it('reads modelName from auth.$context.tables (default = same as collection)', async () => {
    const auth = createBA([organization()]);
    const adapter = await createBetterAuthOverlay({
      auth,
      mongoose,
      collection: 'organization',
    });
    expect(adapter.type).toBe('mongoose');
    // The DataAdapter exposes the underlying model — verify we got the right collection.
    // biome-ignore lint/suspicious/noExplicitAny: adapter.model is structural for tests.
    expect((adapter as any).model.collection.collectionName).toBe('organization');
  });

  it('throws on unknown collection (typo / missing plugin)', async () => {
    const auth = createBA([organization()]);
    await expect(
      createBetterAuthOverlay({ auth, mongoose, collection: 'nonexistent' }),
    ).rejects.toThrow(/has no table named 'nonexistent'/);
  });

  it('picks up plugin tables — twoFactor adds the twoFactor table', async () => {
    const auth = createBA([twoFactor()]);
    const adapter = await createBetterAuthOverlay({
      auth,
      mongoose,
      collection: 'twoFactor',
    });
    expect(adapter.type).toBe('mongoose');
  });

  it('returns a working DataAdapter — repository.getAll reads what BA wrote', async () => {
    const auth = createBA([organization()]);

    // 1. Simulate BA writing an org via its native driver. We bypass BA's
    //    business logic and write directly to the same mongo collection BA
    //    would write to — same byte-for-byte storage.
    const orgsCol = mongoose.connection.db!.collection('organization');
    await orgsCol.insertMany([
      { _id: 'org-1' as never, name: 'Acme', slug: 'acme', createdAt: new Date() },
      { _id: 'org-2' as never, name: 'Globex', slug: 'globex', createdAt: new Date() },
    ]);

    // 2. arc-side: overlay reads via mongokit Repository (full pagination, filter, sort).
    const adapter = await createBetterAuthOverlay({
      auth,
      mongoose,
      collection: 'organization',
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural Repository API for the test.
    const result = (await (adapter.repository as any).getAll({})) as {
      data: Array<{ name: string }>;
      total: number;
    };
    const names = result.data.map((d) => d.name).sort();
    expect(names).toEqual(['Acme', 'Globex']);
    expect(result.total).toBe(2);
  });

  it('throws when stub already registered AND additionalFields requested', async () => {
    const auth = createBA([organization()]);
    // Register the stub first (host might have done this for populate()).
    registerBetterAuthStubs(mongoose, { plugins: ['organization'] });

    // Now try to overlay WITH additionalFields — should throw.
    await expect(
      createBetterAuthOverlay({
        auth,
        mongoose,
        collection: 'organization',
        additionalFields: { code: { type: String } },
      }),
    ).rejects.toThrow(/already registered on mongoose\.models/);
  });

  it('reuses pre-existing stub model when no additionalFields requested', async () => {
    const auth = createBA([organization()]);
    registerBetterAuthStubs(mongoose, { plugins: ['organization'] });

    // No additionalFields — should NOT throw, should reuse the stub.
    const adapter = await createBetterAuthOverlay({
      auth,
      mongoose,
      collection: 'organization',
    });
    expect(adapter.type).toBe('mongoose');
  });

  it('honors BA additionalFields — declaring extra columns flows through', async () => {
    const auth = betterAuth({
      secret: 'mongokit-better-auth-test-secret-32+chars',
      baseURL: 'http://test',
      database: mongodbAdapter(mongoose.connection.getClient().db()),
      emailAndPassword: { enabled: true },
      plugins: [organization()],
      user: {
        // BA-side declaration — additionalFields here become part of the schema
        additionalFields: {
          phone: { type: 'string', required: false },
          isActive: { type: 'boolean', defaultValue: true },
        },
      },
    });

    // The factory reads auth.$context which includes the additionalFields.
    // The created mongoose schema is `strict: false`, so all BA-declared
    // fields round-trip even without redundant Mongoose-side declarations.
    const adapter = await createBetterAuthOverlay({
      auth,
      mongoose,
      collection: 'user',
    });
    expect(adapter.type).toBe('mongoose');

    // Insert via mongo driver, read via the overlay — both routes see all fields.
    // Use a unique id + filter to make the test order-independent (afterEach
    // doesn't touch collections that haven't been hydrated by a Mongoose model).
    const usersCol = mongoose.connection.db!.collection('user');
    await usersCol.deleteMany({});
    await usersCol.insertOne({
      _id: 'usr_x' as never,
      email: 'x@y.io',
      phone: '555-0100',
      isActive: true,
    });
    // biome-ignore lint/suspicious/noExplicitAny: structural getAll for tests.
    const result = (await (adapter.repository as any).getAll({
      filters: { email: 'x@y.io' },
    })) as {
      data: Array<{ phone?: string; isActive?: boolean }>;
    };
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ phone: '555-0100', isActive: true });
  });
});

// ============================================================================
// API-key plugin — separate @better-auth/api-key package
// ============================================================================

describe('createBetterAuthOverlay — apiKey plugin', () => {
  it('exposes the apikey table as an arc resource', async () => {
    const auth = betterAuth({
      secret: 'mongokit-better-auth-test-secret-32+chars',
      baseURL: 'http://test',
      database: mongodbAdapter(mongoose.connection.getClient().db()),
      emailAndPassword: { enabled: true },
      plugins: [apiKey()],
    });

    const adapter = await createBetterAuthOverlay({
      auth,
      mongoose,
      collection: 'apikey',
    });
    expect(adapter.type).toBe('mongoose');

    // Simulate BA writing an api-key row via its native driver. We bypass
    // the apiKey plugin's hashing path and write directly so the test
    // stays focused on the overlay; what matters is the overlay reads
    // the same bytes BA wrote.
    const apikeyCol = mongoose.connection.db!.collection('apikey');
    await apikeyCol.insertOne({
      _id: 'ak_test' as never,
      name: 'Test API Key',
      start: 'ak_live_xxx',
      prefix: 'ak_live',
      key: 'hashed-key-bytes',
      userId: 'usr_1',
      enabled: true,
      rateLimitEnabled: true,
      requestCount: 0,
      remaining: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
    const result = (await (adapter.repository as any).getAll({
      filters: { userId: 'usr_1' },
    })) as { data: Array<{ name: string; enabled: boolean }> };
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ name: 'Test API Key', enabled: true });
  });
});

// ============================================================================
// Multi-plugin schema merge — organization + apiKey + admin together
// ============================================================================

describe('createBetterAuthOverlay — multi-plugin schema merge', () => {
  it('reaches all plugin tables when org + apiKey + admin are stacked', async () => {
    const auth = betterAuth({
      secret: 'mongokit-better-auth-test-secret-32+chars',
      baseURL: 'http://test',
      database: mongodbAdapter(mongoose.connection.getClient().db()),
      emailAndPassword: { enabled: true },
      plugins: [organization(), apiKey(), admin()],
    });

    // organization plugin: organization, member, invitation
    // apiKey plugin: apikey
    // admin plugin: field-only additions to user (no new tables)
    const tables = ['organization', 'member', 'invitation', 'apikey', 'user'];
    for (const collection of tables) {
      const adapter = await createBetterAuthOverlay({ auth, mongoose, collection });
      expect(adapter.type).toBe('mongoose');
    }
  });
});

// ============================================================================
// Write path — overlay's Repository.create() persists; BA reads see it
// ============================================================================

describe('createBetterAuthOverlay — write path', () => {
  it('repository.create writes a row that subsequent reads see', async () => {
    const auth = betterAuth({
      secret: 'mongokit-better-auth-test-secret-32+chars',
      baseURL: 'http://test',
      database: mongodbAdapter(mongoose.connection.getClient().db()),
      emailAndPassword: { enabled: true },
      plugins: [organization()],
    });

    const adapter = await createBetterAuthOverlay({
      auth,
      mongoose,
      collection: 'organization',
    });

    // Clear collection first — afterEach can miss collections that
    // weren't hydrated by a Mongoose model in the prior test.
    await mongoose.connection.db!.collection('organization').deleteMany({});

    // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
    const repo = adapter.repository as any;
    // Mongoose's strict:false stub schema uses ObjectId for _id by default;
    // BA uses string ids in real flows. Test the write path by NOT supplying
    // _id (Mongoose generates an ObjectId), then read back by a custom field.
    await repo.create({
      name: 'WriteTest Inc',
      slug: 'writetest',
      createdAt: new Date(),
    });

    // Read back via the overlay
    const result = (await repo.getAll({ filters: { slug: 'writetest' } })) as {
      data: Array<{ name: string }>;
    };
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.name).toBe('WriteTest Inc');

    // And via direct mongo driver — proves the overlay wrote to the
    // SAME collection BA reads from.
    const direct = await mongoose.connection
      .db!.collection('organization')
      .findOne({ slug: 'writetest' });
    expect(direct?.name).toBe('WriteTest Inc');
  });
});

// ============================================================================
// Multi-role member — BA stores `role: "admin,recruiter"` (comma-separated)
// ============================================================================

describe('createBetterAuthOverlay — multi-role member field', () => {
  it('round-trips comma-separated role string unchanged', async () => {
    const auth = betterAuth({
      secret: 'mongokit-better-auth-test-secret-32+chars',
      baseURL: 'http://test',
      database: mongodbAdapter(mongoose.connection.getClient().db()),
      emailAndPassword: { enabled: true },
      plugins: [organization()],
    });

    // BA writes a member with multiple roles in a single column —
    // canonical organization-plugin pattern (be-prod uses this).
    const memberCol = mongoose.connection.db!.collection('member');
    await memberCol.insertOne({
      _id: 'mem_1' as never,
      organizationId: 'org_a',
      userId: 'usr_a',
      role: 'admin,recruiter,viewer',
      createdAt: new Date(),
    });

    const adapter = await createBetterAuthOverlay({
      auth,
      mongoose,
      collection: 'member',
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
    const result = (await (adapter.repository as any).getAll({})) as {
      data: Array<{ role: string }>;
    };
    // The overlay surfaces the raw string as BA stored it. Splitting
    // is the consumer's responsibility — arc's request-side adapter
    // already does this for `request.scope.orgRoles`. Hosts reading
    // the `member` table directly should split themselves.
    expect(result.data[0]?.role).toBe('admin,recruiter,viewer');
    expect(result.data[0]!.role.split(',')).toEqual(['admin', 'recruiter', 'viewer']);
  });

  it('exact-match filter (?role=admin) does NOT match multi-role members', async () => {
    const auth = betterAuth({
      secret: 'mongokit-better-auth-test-secret-32+chars',
      baseURL: 'http://test',
      database: mongodbAdapter(mongoose.connection.getClient().db()),
      emailAndPassword: { enabled: true },
      plugins: [organization()],
    });

    const memberCol = mongoose.connection.db!.collection('member');
    // Clear pre-existing rows from prior tests (afterEach can miss collections
    // not hydrated by a Mongoose model during this run).
    await memberCol.deleteMany({});
    await memberCol.insertMany([
      {
        _id: 'mem_solo' as never,
        organizationId: 'org_a',
        userId: 'usr_solo',
        role: 'admin',
        createdAt: new Date(),
      },
      {
        _id: 'mem_multi' as never,
        organizationId: 'org_a',
        userId: 'usr_multi',
        role: 'admin,recruiter',
        createdAt: new Date(),
      },
    ]);

    const adapter = await createBetterAuthOverlay({
      auth,
      mongoose,
      collection: 'member',
    });

    // Exact-match filter — only `mem_solo` matches.
    // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
    const exact = (await (adapter.repository as any).getAll({
      filters: { role: 'admin' },
    })) as { data: Array<{ _id: string }> };
    expect(exact.data.map((d) => d._id)).toEqual(['mem_solo']);

    // Mongo regex / contains — finds both. Documents the queryparser
    // pattern hosts should use when they want to query multi-role rows.
    // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
    const contains = (await (adapter.repository as any).getAll({
      filters: { role: { $regex: 'admin' } },
    })) as { data: Array<{ _id: string }> };
    expect(contains.data.map((d) => d._id).sort()).toEqual(['mem_multi', 'mem_solo']);
  });
});

// ============================================================================
// Sensitive fields — overlay surfaces them; host MUST hide them at resource layer
// ============================================================================

describe('createBetterAuthOverlay — sensitive fields', () => {
  it('account.password and apikey.key round-trip via the overlay (host must hide them)', async () => {
    const auth = betterAuth({
      secret: 'mongokit-better-auth-test-secret-32+chars',
      baseURL: 'http://test',
      database: mongodbAdapter(mongoose.connection.getClient().db()),
      emailAndPassword: { enabled: true },
      plugins: [apiKey()],
    });

    // The overlay does NOT strip sensitive fields — that's a host-layer
    // concern. arc consumers should declare `fields: { password: hidden() }`
    // / `fields: { key: hidden() }` on the resource. The test asserts the
    // raw round-trip so future regressions don't accidentally start hiding
    // fields the host expected to read.
    const accountsCol = mongoose.connection.db!.collection('account');
    await accountsCol.insertOne({
      _id: 'acc_1' as never,
      userId: 'usr_1',
      providerId: 'credential',
      accountId: 'usr_1',
      password: 'BCRYPT_HASH_DO_NOT_LEAK',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const accountAdapter = await createBetterAuthOverlay({
      auth,
      mongoose,
      collection: 'account',
    });
    // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
    const accounts = (await (accountAdapter.repository as any).getAll({})) as {
      data: Array<{ password?: string }>;
    };
    expect(accounts.data[0]?.password).toBe('BCRYPT_HASH_DO_NOT_LEAK');

    const apikeyCol = mongoose.connection.db!.collection('apikey');
    await apikeyCol.insertOne({
      _id: 'ak_1' as never,
      name: 'k',
      key: 'HASHED_KEY_DO_NOT_LEAK',
      userId: 'usr_1',
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const apikeyAdapter = await createBetterAuthOverlay({
      auth,
      mongoose,
      collection: 'apikey',
    });
    // biome-ignore lint/suspicious/noExplicitAny: structural Repository for tests.
    const apikeys = (await (apikeyAdapter.repository as any).getAll({})) as {
      data: Array<{ key?: string }>;
    };
    expect(apikeys.data[0]?.key).toBe('HASHED_KEY_DO_NOT_LEAK');
  });
});
