/**
 * Optimistic-concurrency CAS (`WriteOptions.ifVersion`) — the contract's own pin.
 *
 * The feature shipped in 3.33.0 with NO test, which is FAIL LOUD rule 4: repo-core's
 * contract says "on mismatch the kit MUST throw VersionConflictError", and nothing
 * held mongokit to it. The gap was real: `updateByQuery` throws its own 404 on ANY
 * filter miss when `throwOnNotFound` rides the context, so a CAS miss with the flag
 * set answered "Document not found" for a document that EXISTS — a false statement
 * that reads as record-gone and invites the blind retry the CAS exists to prevent.
 * Found live: invoice `changePlan`'s losing racer got a 404 instead of its 409.
 *
 * The four outcomes pinned here are the whole contract:
 *   match            → applied, version bumped in the SAME operation
 *   version moved    → VersionConflictError — regardless of throwOnNotFound
 *   record gone      → null, or 404 when throwOnNotFound asked for it
 */

import { isVersionConflictError } from '@classytic/repo-core/errors';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../src/Repository.js';
import { clearDB, connectDB, createTestModel, disconnectDB } from './setup.js';

interface IAccount {
  _id: mongoose.Types.ObjectId;
  name: string;
  balance: number;
  __v: number;
}

const AccountSchema = new mongoose.Schema<IAccount>({
  name: { type: String, required: true },
  balance: { type: Number, required: true, default: 0 },
});

let repo: Repository<IAccount>;

beforeAll(async () => {
  await connectDB();
  const model = await createTestModel<IAccount>('CasAccount', AccountSchema);
  repo = new Repository<IAccount>(model);
});
afterAll(disconnectDB);
beforeEach(clearDB);

describe('ifVersion CAS', () => {
  it('match: applies the patch and bumps the version in the same operation', async () => {
    const doc = await repo.create({ name: 'a', balance: 100 });
    const updated = await repo.update(String(doc._id), { balance: 150 }, { ifVersion: doc.__v });

    expect(updated?.balance).toBe(150);
    // The bump IS the fence: a versioned write that left the version alone
    // would let the next writer pass the same CAS and clobber this one.
    expect(updated?.__v).toBe(doc.__v + 1);
  });

  it('version moved: throws VersionConflictError carrying both versions', async () => {
    const doc = await repo.create({ name: 'a', balance: 100 });
    await repo.update(String(doc._id), { balance: 150 }, { ifVersion: doc.__v });

    const err = await repo
      .update(String(doc._id), { balance: 999 }, { ifVersion: doc.__v })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).not.toBeNull();
    expect(isVersionConflictError(err)).toBe(true);
    // The losing write must not have applied.
    const fresh = await repo.getById(String(doc._id));
    expect(fresh?.balance).toBe(150);
  });

  it('version moved + throwOnNotFound: STILL VersionConflictError, never 404', async () => {
    // The regression this file exists for. throwOnNotFound made updateByQuery
    // 404 on the CAS-filter miss BEFORE the disambiguation ran — "not found"
    // for a document that exists.
    const doc = await repo.create({ name: 'a', balance: 100 });
    await repo.update(String(doc._id), { balance: 150 }, { ifVersion: doc.__v });

    const err = await repo
      .update(String(doc._id), { balance: 999 }, { ifVersion: doc.__v, throwOnNotFound: true })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(isVersionConflictError(err)).toBe(true);
    expect((err as { status?: number; statusCode?: number }).statusCode ?? 0).not.toBe(404);
  });

  it('record gone: null by default, 404 only when throwOnNotFound asks', async () => {
    const ghost = new mongoose.Types.ObjectId();

    await expect(repo.update(String(ghost), { balance: 1 }, { ifVersion: 0 })).resolves.toBeNull();

    const err = await repo
      .update(String(ghost), { balance: 1 }, { ifVersion: 0, throwOnNotFound: true })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).not.toBeNull();
    expect(isVersionConflictError(err)).toBe(false); // genuinely gone ≠ conflicted
  });
});

/**
 * CAS AUTHORITY — the caller's `id` and `ifVersion` are constraints a hook
 * must not be able to relax.
 *
 * `context.query` is hook-supplied scope (multi-tenant, soft-delete). It was
 * spread LAST into the CAS filter, so an injected `_id` retargeted the write
 * to a different document and an injected version defeated the compare-and-set
 * that is the entire point of the branch. Scope narrows; it never redirects.
 */
describe('ifVersion CAS — filter authority', () => {
  // Hooks have no removal API, so each case gets its OWN repository instance
  // over the shared model — the hook dies with it instead of leaking.
  const scopedRepo = (inject: Record<string, unknown>) => {
    const r = new Repository<IAccount>(repo.Model);
    r.on('before:update', (ctx: { query?: Record<string, unknown> }) => {
      ctx.query = { ...(ctx.query ?? {}), ...inject };
    });
    return r;
  };

  it('an injected _id CANNOT retarget the write', async () => {
    const target = await repo.create({ name: 'target', balance: 100 });
    const other = await repo.create({ name: 'other', balance: 999 });

    const r = scopedRepo({ _id: other._id });
    await r.update(String(target._id), { balance: 150 }, { ifVersion: target.__v });

    // The caller's id won: target moved, the other document is untouched.
    expect((await repo.getById(String(target._id)))?.balance).toBe(150);
    expect((await repo.getById(String(other._id)))?.balance).toBe(999);
  });

  it('an injected version CANNOT defeat the compare-and-set', async () => {
    const doc = await repo.create({ name: 'a', balance: 100 });
    await repo.update(String(doc._id), { balance: 150 }, { ifVersion: doc.__v }); // now v+1

    // The hook injects the CURRENT version; the caller passes the STALE one.
    const r = scopedRepo({ __v: doc.__v + 1 });
    await expect(
      r.update(String(doc._id), { balance: 999 }, { ifVersion: doc.__v }),
    ).rejects.toMatchObject({ name: 'VersionConflictError' });

    expect((await repo.getById(String(doc._id)))?.balance).toBe(150);
  });

  it('injected scope still NARROWS — a tenant filter that misses yields no write', async () => {
    // The other half of the contract: authority-last must not neuter scope.
    const doc = await repo.create({ name: 'a', balance: 100 });
    const r = scopedRepo({ name: 'a-different-name' });
    const res = await r.update(String(doc._id), { balance: 150 }, { ifVersion: doc.__v });
    expect(res).toBeNull();
    expect((await repo.getById(String(doc._id)))?.balance).toBe(100);
  });
});

/**
 * The CAS owns the version field exclusively. A payload that also touches it
 * either fails with a Mongo path-conflict naming an internal field the caller
 * never wrote, or is silently overridden — neither actionable, so both are
 * refused up front.
 */
describe('ifVersion CAS — version-field ownership', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['$set', { $set: { __v: 20 } }],
    ['$unset', { $unset: { __v: '' } }],
    ['$rename', { $rename: { __v: 'oldVersion' } }],
    ['$inc other than 1', { $inc: { __v: 5 } }],
    ['flat field', { __v: 20 }],
  ];

  for (const [label, payload] of cases) {
    it(`REFUSES ${label} targeting the version field`, async () => {
      const doc = await repo.create({ name: 'a', balance: 100 });
      await expect(
        repo.update(String(doc._id), payload as Partial<IAccount>, { ifVersion: doc.__v }),
      ).rejects.toThrow(/owns that field/);
      // Refused BEFORE the write — nothing moved.
      expect((await repo.getById(String(doc._id)))?.__v).toBe(doc.__v);
    });
  }

  it('ACCEPTS $inc: { __v: 1 } — it states exactly what the CAS does anyway', async () => {
    const doc = await repo.create({ name: 'a', balance: 100 });
    const updated = await repo.update(
      String(doc._id),
      { $inc: { balance: 5, __v: 1 } } as unknown as Partial<IAccount>,
      { ifVersion: doc.__v },
    );
    expect(updated?.balance).toBe(105);
    expect(updated?.__v).toBe(doc.__v + 1); // bumped ONCE, not twice
  });

  it('REFUSES a mixed operator/flat payload — the shared write-loss guard applies here too', async () => {
    const doc = await repo.create({ name: 'a', balance: 100 });
    await expect(
      repo.update(
        String(doc._id),
        { $inc: { balance: 5 }, name: 'dropped' } as unknown as Partial<IAccount>,
        { ifVersion: doc.__v },
      ),
    ).rejects.toThrow(/assertNoMixedPatchShape/);
  });
});

/**
 * `MongoOperationTimeoutError` keeps its IDENTITY through the error handler.
 *
 * A `timeoutMS` expiry is UNKNOWN, not FAILED — the in-flight write may have
 * already committed server-side. Collapsing it into a generic 500 destroys the
 * one signal that tells a caller "reconcile by state" apart from "this truly
 * errored", so the class must survive unwrapped.
 */
describe('MongoOperationTimeoutError identity', () => {
  it('passes through _handleError unwrapped, class intact', () => {
    const timeout = new mongoose.mongo.MongoOperationTimeoutError('operation timed out');
    const handled = (repo as unknown as { _handleError(e: Error): Error })._handleError(timeout);

    // Same object, same class — not re-wrapped into a 500.
    expect(handled).toBe(timeout);
    expect(handled).toBeInstanceOf(mongoose.mongo.MongoOperationTimeoutError);
    expect((handled as unknown as { status?: number }).status).toBeUndefined();
  });

  it('a plain error still collapses to 500 — the passthrough is narrow', () => {
    const handled = (
      repo as unknown as { _handleError(e: Error): { status: number } }
    )._handleError(new Error('something else'));
    expect(handled.status).toBe(500);
  });
});
