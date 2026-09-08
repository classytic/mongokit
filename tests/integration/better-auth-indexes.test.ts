/**
 * Integration tests for `ensureBetterAuthIndexes`.
 *
 * Better Auth's mongo adapter creates NO indexes — not on `session.token`
 * (read on every authenticated request), not a unique one on `user.email`.
 * These tests assert against a REAL mongo connection that the helper closes
 * that gap, that it is idempotent, and — the load-bearing behaviour — that a
 * collection already holding duplicates DEGRADES the unique index instead of
 * throwing and taking the boot down with it.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BA_INDEXES_BY_PLUGIN,
  ensureBetterAuthIndexes,
} from '../../src/better-auth/index.js';
import { connectDB, disconnectDB } from '../setup.js';

/**
 * Index names on a collection, excluding mongo's implicit `_id_`.
 * A collection the helper never touched does not exist at all, and mongo
 * answers `listIndexes` on a missing namespace with an error — that is the
 * same observable as "no indexes", so normalise it to `[]`.
 */
async function indexNames(collection: string): Promise<string[]> {
  try {
    const ixs = await mongoose.connection.db!.collection(collection).indexes();
    return ixs.map((ix) => String(ix.name)).filter((n) => n !== '_id_').sort();
  } catch {
    return [];
  }
}

async function indexByName(collection: string, name: string) {
  try {
    const ixs = await mongoose.connection.db!.collection(collection).indexes();
    return ixs.find((ix) => ix.name === name) as
      | { unique?: boolean; expireAfterSeconds?: number; key: Record<string, number> }
      | undefined;
  } catch {
    return undefined;
  }
}

beforeAll(async () => {
  await connectDB();
});

afterAll(async () => {
  await disconnectDB();
});

beforeEach(async () => {
  const db = mongoose.connection.db!;
  for (const name of ['user', 'session', 'account', 'verification', 'organization', 'member', 'invitation']) {
    await db.collection(name).deleteMany({});
    await db.collection(name).dropIndexes().catch(() => undefined);
  }
});

describe('ensureBetterAuthIndexes', () => {
  it('creates the core index set BA never creates itself', async () => {
    const results = await ensureBetterAuthIndexes(mongoose.connection as never);

    expect(results.every((r) => r.status === 'created')).toBe(true);
    expect(await indexNames('session')).toContain('ba_session_token');
    expect(await indexNames('session')).toContain('ba_session_userId');
    expect(await indexNames('user')).toContain('ba_user_email');
    expect(await indexNames('account')).toContain('ba_account_issuer_accountId');
    expect(await indexNames('verification')).toContain('ba_verification_identifier');
  });

  it('marks session.token and user.email unique', async () => {
    await ensureBetterAuthIndexes(mongoose.connection as never);
    expect((await indexByName('session', 'ba_session_token'))?.unique).toBe(true);
    expect((await indexByName('user', 'ba_user_email'))?.unique).toBe(true);
  });

  it('creates TTL indexes that bound the self-expiring collections', async () => {
    await ensureBetterAuthIndexes(mongoose.connection as never);
    // expireAfterSeconds: 0 => reap once each row's own expiresAt has passed.
    expect((await indexByName('session', 'ttl_session_expiresAt'))?.expireAfterSeconds).toBe(0);
    expect((await indexByName('verification', 'ttl_verification_expiresAt'))?.expireAfterSeconds).toBe(0);
  });

  it('is idempotent — a second run changes nothing and still reports created', async () => {
    await ensureBetterAuthIndexes(mongoose.connection as never);
    const before = await indexNames('session');
    const results = await ensureBetterAuthIndexes(mongoose.connection as never);
    expect(results.some((r) => r.status === 'failed')).toBe(false);
    expect(await indexNames('session')).toEqual(before);
  });

  it('DEGRADES a unique index instead of throwing when duplicates already exist', async () => {
    // The real-world case: historical rows violate uniqueness. Refusing to boot
    // over that would be worse than running with a plain lookup index.
    await mongoose.connection.db!.collection('user').insertMany([
      { email: 'dupe@example.com', name: 'A' },
      { email: 'dupe@example.com', name: 'B' },
    ]);

    const results = await ensureBetterAuthIndexes(mongoose.connection as never);
    const email = results.find((r) => r.name === 'ba_user_email');

    expect(email?.status).toBe('degraded');
    expect(email?.reason).toBeTruthy();
    // The lookup index still exists, just without the unique constraint.
    expect(await indexNames('user')).toContain('ba_user_email');
    expect((await indexByName('user', 'ba_user_email'))?.unique).toBeUndefined();
  });

  it('only touches core collections until a plugin is requested', async () => {
    await ensureBetterAuthIndexes(mongoose.connection as never);
    expect(await indexNames('organization')).toEqual([]);

    await ensureBetterAuthIndexes(mongoose.connection as never, { plugins: ['organization'] });
    expect(await indexNames('organization')).toContain('ba_organization_slug');
    expect(await indexNames('member')).toContain('ba_member_org_user');
  });

  it('honours usePlural and modelOverrides when resolving collection names', async () => {
    await ensureBetterAuthIndexes(mongoose.connection as never, { usePlural: true });
    expect(await indexNames('users')).toContain('ba_user_email');
    // The singular collection is left untouched.
    expect(await indexNames('user')).toEqual([]);

    await ensureBetterAuthIndexes(mongoose.connection as never, {
      modelOverrides: { session: 'auth_sessions' },
    });
    expect(await indexNames('auth_sessions')).toContain('ba_session_token');
  });

  it('skips excluded collections', async () => {
    await ensureBetterAuthIndexes(mongoose.connection as never, { exclude: ['user'] });
    expect(await indexNames('user')).toEqual([]);
    expect(await indexNames('session')).toContain('ba_session_token');
  });

  it('declares an index for every hot Better Auth lookup path', () => {
    const core = BA_INDEXES_BY_PLUGIN.core!;
    // Guards against someone trimming the spec: these back per-request reads.
    expect(core.some((s) => s.collection === 'session' && 'token' in s.keys)).toBe(true);
    expect(core.some((s) => s.collection === 'user' && 'email' in s.keys)).toBe(true);
    expect(core.some((s) => s.collection === 'account' && 'accountId' in s.keys)).toBe(true);
  });
});
