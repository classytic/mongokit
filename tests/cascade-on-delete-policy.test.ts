/**
 * `onDelete` policy — the application-level `ON DELETE` MongoDB does not provide.
 *
 * Mongo has no foreign keys. Odoo, which hard-deletes almost everything, leans on Postgres
 * `ondelete='restrict'` in 31 places in its accounting module alone — that enforcement is
 * what lets it skip soft delete entirely. Without an equivalent, a hard delete here leaves
 * dangling references, and the usual workaround is to soft-delete the parent forever, which
 * HIDES the row instead of REFUSING the operation.
 *
 * Three policies, matching the RDBMS vocabulary:
 *   - `cascade`  (default, pre-existing) — delete the children
 *   - `restrict` — refuse while any reference remains
 *   - `detach`   — clear the reference, keep the child (`SET NULL`)
 *
 * The property that makes `restrict` worth anything is ORDERING: it must run `before:delete`.
 * A check that ran after would report the violation with the parent already gone — the exact
 * "returns a plausible answer, changes nothing" failure this codebase is built to avoid. The
 * test below asserts the parent SURVIVES, not merely that an error was thrown.
 */

import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cascadePlugin, methodRegistryPlugin, Repository } from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

const parentSchema = new Schema({ name: String }, { timestamps: true });
const childSchema = new Schema(
  { label: String, parent: { type: Schema.Types.ObjectId, index: true } },
  { timestamps: true },
);

let ParentModel: Awaited<ReturnType<typeof createTestModel>>;
let ChildModel: Awaited<ReturnType<typeof createTestModel>>;

beforeAll(async () => {
  await connectDB();
  // `createTestModel` is ASYNC — awaiting it matters: without it the binding is a Promise
  // and every call fails as `X.deleteMany is not a function`, which reads like a plugin bug.
  ParentModel = await createTestModel('OnDeleteParent', parentSchema);
  ChildModel = await createTestModel('OnDeleteChild', childSchema);
});

afterAll(async () => {
  await disconnectDB();
});

beforeEach(async () => {
  await ParentModel.deleteMany({});
  await ChildModel.deleteMany({});
});

const childRepo = () => new Repository(ChildModel as never, [methodRegistryPlugin()]);

const parentRepoWith = (onDelete: 'cascade' | 'restrict' | 'detach') =>
  new Repository(ParentModel as never, [
    methodRegistryPlugin(),
    cascadePlugin({ relations: [{ repo: childRepo() as never, foreignKey: 'parent', onDelete }] }),
  ]);

async function seed(): Promise<{ parentId: Types.ObjectId }> {
  const parent = await ParentModel.create({ name: 'p' });
  await ChildModel.create({ label: 'c1', parent: parent._id });
  await ChildModel.create({ label: 'c2', parent: parent._id });
  return { parentId: parent._id as Types.ObjectId };
}

describe("onDelete: 'restrict'", () => {
  it('REFUSES the delete and leaves the parent in place', async () => {
    const { parentId } = await seed();
    const repo = parentRepoWith('restrict');

    await expect(repo.delete(String(parentId))).rejects.toThrow(/still reference it/i);

    // The property that matters: not "an error was thrown" but "nothing was deleted".
    // A restrict wired on `after:delete` would also throw — with the parent already gone.
    expect(await ParentModel.countDocuments({ _id: parentId })).toBe(1);
    expect(await ChildModel.countDocuments({ parent: parentId })).toBe(2);
  });

  it('carries a stable code and the numbers an operator needs', async () => {
    const { parentId } = await seed();
    const repo = parentRepoWith('restrict');

    const err = await repo.delete(String(parentId)).catch((e: unknown) => e);
    const typed = err as Error & { code?: string; details?: Record<string, unknown> };
    // A code, so a host maps it to 409 without parsing prose.
    expect(typed.code).toBe('REFERENCE_RESTRICTED');
    expect(typed.details?.foreignKey).toBe('parent');
    expect(typed.details?.count).toBe(2);
  });

  it('ALLOWS the delete once the last reference is gone', async () => {
    const { parentId } = await seed();
    const repo = parentRepoWith('restrict');

    await ChildModel.deleteMany({ parent: parentId });
    await repo.delete(String(parentId));

    expect(await ParentModel.countDocuments({ _id: parentId })).toBe(0);
  });
});

describe("onDelete: 'detach'", () => {
  it('clears the reference and KEEPS the child', async () => {
    const { parentId } = await seed();
    await parentRepoWith('detach').delete(String(parentId));

    expect(await ParentModel.countDocuments({ _id: parentId })).toBe(0);
    // The child survives — this is `SET NULL`, not a delete.
    expect(await ChildModel.countDocuments({})).toBe(2);
    expect(await ChildModel.countDocuments({ parent: { $exists: true } })).toBe(0);
  });
});

/**
 * BULK PARITY — the path the first cut got destructively wrong.
 *
 * The single-delete path split the policies; `deleteMany` then passed EVERY relation to the
 * cascade, so a `restrict` relation had its children DELETED and a `detach` relation did too.
 * Bulk was strictly worse than declaring no policy at all, and the six single-delete tests all
 * passed while it was true. Policy parity across delete shapes is the invariant, not the
 * single-document behaviour.
 */
describe('deleteMany — policy parity with single delete', () => {
  it("restrict REFUSES a bulk delete and deletes NOTHING", async () => {
    const { parentId } = await seed();
    const repo = parentRepoWith('restrict');

    await expect(repo.deleteMany({ name: 'p' })).rejects.toThrow(/still reference/i);

    // Both halves: the parents survive AND the children were not cascaded away.
    expect(await ParentModel.countDocuments({ _id: parentId })).toBe(1);
    expect(await ChildModel.countDocuments({ parent: parentId })).toBe(2);
  });

  it('detach in bulk clears the reference and KEEPS the children', async () => {
    const { parentId } = await seed();
    await parentRepoWith('detach').deleteMany({ name: 'p' });

    expect(await ParentModel.countDocuments({ _id: parentId })).toBe(0);
    expect(await ChildModel.countDocuments({})).toBe(2);
    expect(await ChildModel.countDocuments({ parent: { $exists: true } })).toBe(0);
  });

  it('cascade in bulk still deletes children — unchanged', async () => {
    const { parentId } = await seed();
    await parentRepoWith('cascade').deleteMany({ name: 'p' });
    expect(await ChildModel.countDocuments({ parent: parentId })).toBe(0);
  });
});

describe('default policy', () => {
  it('an ABSENT onDelete still cascades — the pre-existing behaviour is unchanged', async () => {
    const { parentId } = await seed();
    const repo = new Repository(ParentModel as never, [
      methodRegistryPlugin(),
      // No `onDelete` at all: every relation declared before this feature existed.
      cascadePlugin({ relations: [{ repo: childRepo() as never, foreignKey: 'parent' }] }),
    ]);

    await repo.delete(String(parentId));
    expect(await ChildModel.countDocuments({ parent: parentId })).toBe(0);
  });
});

/**
 * The guarded key MUST be indexed.
 *
 * `restrict`/`detach` query the child collection on EVERY delete, and Mongo gives no index for
 * free the way an FK constraint does. Unindexed, each delete is a collection scan — invisible
 * against small test fixtures and crippling in production. Documentation ("SHOULD be indexed")
 * stops no scan, which is why step 4 of the plan was reopened until this existed.
 */
/**
 * DELETION-SURFACE COVERAGE.
 *
 * A guard on `before:delete` protects only the surfaces that route through the repository.
 * `purgeByField`/`purgeByFilter` are the compliance path the Data Cleanup Center uses, so if
 * they bypassed the hook, declaring `restrict` and dropping soft delete would just move the
 * hole somewhere less visible.
 *
 * They do NOT bypass it — `actions/purge.ts` issues `repo.deleteMany(chunkFilter, {mode:'hard'})`
 * per chunk — but that is a claim worth a test rather than a reading, because it is exactly the
 * kind of routing detail that changes without anyone revisiting the guard.
 */
describe('deletion surfaces — purge routes through the guard', () => {
  /**
   * The refusal arrives as a RESULT, not an exception — and that is by contract.
   *
   * `runChunkedPurge` "never throws for in-strategy errors (those wrap into `result.error`)".
   * So the guard DOES fire and nothing is deleted, but `purgeByField` RESOLVES. A caller that
   * ignores `result.ok` will read a refused purge as a successful one.
   *
   * That is the operative fact for the Data Cleanup Center, and it is why this asserts the
   * envelope AND the row counts rather than a rejection.
   *
   * (`strategy` is an OBJECT (`{type}`), not a string. Passing `'hard'` leaves `strategy.type`
   * undefined, the switch matches nothing, and the purge deletes NOTHING while resolving —
   * indistinguishable from "the guard fired". Hence the denominator test below.)
   */
  it('purgeByField is REFUSED while references remain — reported in the envelope', async () => {
    const { parentId } = await seed();
    const repo = parentRepoWith('restrict');

    const result = (await (repo as unknown as {
      purgeByField: (f: string, v: unknown, s: unknown, o?: unknown) => Promise<unknown>;
    }).purgeByField('name', 'p', { type: 'hard' }, {})) as {
      ok: boolean;
      processed: number;
      error?: { message?: string };
    };

    expect(result.ok, 'a refused purge must not report success').toBe(false);
    expect(result.error?.message ?? '').toMatch(/still reference/i);
    expect(result.processed).toBe(0);

    // And it really refused: nothing on either side was removed.
    expect(await ParentModel.countDocuments({ _id: parentId })).toBe(1);
    expect(await ChildModel.countDocuments({ parent: parentId })).toBe(2);
  });

  /**
   * The DENOMINATOR for the test above: prove this purge call really deletes when nothing
   * blocks it. Without this, a mis-shaped `strategy` (or any other silently-inert call) would
   * make the refusal test pass for the wrong reason — it would be asserting that a no-op
   * did nothing.
   */
  it('the same purge call DOES delete once the references are gone', async () => {
    const { parentId } = await seed();
    await ChildModel.deleteMany({ parent: parentId });

    await (parentRepoWith('restrict') as unknown as {
      purgeByField: (f: string, v: unknown, s: unknown, o?: unknown) => Promise<unknown>;
    }).purgeByField('name', 'p', { type: 'hard' }, {});

    expect(await ParentModel.countDocuments({ _id: parentId })).toBe(0);
  });
});

describe('foreign-key index enforcement', () => {
  const unindexedSchema = new Schema({ label: String, parent: { type: Schema.Types.ObjectId } });

  it("THROWS at bind time when a restrict/detach key has no index", async () => {
    const Unindexed = await createTestModel('OnDeleteUnindexedChild', unindexedSchema);
    const childless = new Repository(Unindexed as never, [methodRegistryPlugin()]);

    // The throw is at APPLY (bind) time — constructing the Repository is what applies plugins.
    expect(
      () =>
        new Repository(ParentModel as never, [
          methodRegistryPlugin(),
          cascadePlugin({
            relations: [{ repo: childless as never, foreignKey: 'parent', onDelete: 'restrict' }],
          }),
        ]),
    ).toThrow(/requires an index/i);
  });

  it('accepts a COMPOUND index whose FIRST key is the foreign key (Mongo prefix rule)', async () => {
    const compound = new Schema({ label: String, parent: Schema.Types.ObjectId });
    compound.index({ parent: 1, label: 1 });
    const Compound = await createTestModel('OnDeleteCompoundChild', compound);
    const compoundRepo = new Repository(Compound as never, [methodRegistryPlugin()]);

    expect(
      () =>
        new Repository(ParentModel as never, [
          methodRegistryPlugin(),
          cascadePlugin({
            relations: [{ repo: compoundRepo as never, foreignKey: 'parent', onDelete: 'restrict' }],
          }),
        ]),
    ).not.toThrow();
  });

  it('does NOT require an index for plain cascade — it does not query the key', async () => {
    const Unindexed2 = await createTestModel('OnDeleteUnindexedChild2', unindexedSchema);
    const repo2 = new Repository(Unindexed2 as never, [methodRegistryPlugin()]);

    expect(
      () =>
        new Repository(ParentModel as never, [
          methodRegistryPlugin(),
          cascadePlugin({ relations: [{ repo: repo2 as never, foreignKey: 'parent' }] }),
        ]),
    ).not.toThrow();
  });
});

/**
 * TTL on a protected parent is a contradiction the plugin cannot resolve.
 *
 * `restrict` says "never delete while referenced"; a TTL index says "delete after N seconds,
 * server-side". Mongo's expiry thread runs NO application code — no repository, no hook, no
 * count — so it removes the parent and orphans every child, silently, at a time nobody chose.
 * Bind time is the only moment both declarations are visible together.
 *
 * This matters directly here: three of the four soft-delete holdouts use `ttlDays: 2555`.
 */
/**
 * The restrict count must carry the parent's SESSION and SCOPE.
 *
 * Asserted on the OPTIONS the target repository receives, not on a database outcome. That is
 * deliberate: the first cut called `targetRepo.count(filter)` with neither, and a
 * database-outcome test would have passed anyway on a standalone server with no tenancy —
 * exactly the conditions of this suite. What changed is the wiring, so the wiring is what is
 * pinned.
 *
 * Why each matters:
 *   - **session** — without it the count reads OUTSIDE the parent's transaction, so a child
 *     created in that same uncommitted transaction is invisible and the guard passes.
 *   - **scope** — without it a tenant-scoped target reads unscoped, refusing a delete because
 *     ANOTHER tenant still references the row, or relies on ambient context a background job
 *     does not have.
 */
describe('restrict count — session and scope forwarding', () => {
  it('forwards session and organizationId to the target repository count', async () => {
    const seen: Array<{ filter: unknown; options: unknown }> = [];
    /**
     * A REAL session, not a double. `startSession()` works on a standalone server — only
     * `startTransaction()` needs a replica set — and the repository's delete path calls
     * methods on it (`inTransaction()` and more). Hand-shaping a fake means chasing each one
     * and testing the mock rather than the wiring.
     */
    const fakeSession = await mongoose.startSession();

    const spyChild = {
      Model: ChildModel,
      count: async (filter: unknown, options: unknown) => {
        seen.push({ filter, options });
        return 0; // no references — let the delete proceed
      },
    };

    const repo = new Repository(ParentModel as never, [
      methodRegistryPlugin(),
      cascadePlugin({
        relations: [{ repo: spyChild as never, foreignKey: 'parent', onDelete: 'restrict' }],
      }),
    ]);

    const parent = await ParentModel.create({ name: 'p' });
    await repo.delete(String(parent._id), {
      session: fakeSession,
      organizationId: 'org-42',
    } as never);

    expect(seen.length, 'the guard must have queried the target').toBe(1);
    const options = seen[0]?.options as Record<string, unknown>;
    expect(options?.session, 'session must be forwarded').toBe(fakeSession);
    expect(options?.organizationId, 'tenant scope must be forwarded').toBe('org-42');
  });

  it('REFUSES a target repository with no count() rather than falling back to a raw count', () => {
    const countless = { Model: ChildModel } as never; // no `count`
    const repo = new Repository(ParentModel as never, [
      methodRegistryPlugin(),
      cascadePlugin({
        relations: [{ repo: countless, foreignKey: 'parent', onDelete: 'restrict' }],
      }),
    ]);
    // A raw `Model.countDocuments` fallback would silently bypass the target's own policy —
    // the very thing this guard exists to respect.
    return expect(repo.delete('000000000000000000000001')).rejects.toThrow(/needs a repository with/i);
  });
});

/**
 * Gate 3 — failure injection between the parent delete and the child operation.
 *
 * `cascade`/`detach` run AFTER the parent is gone. Without a caller-owned transaction there is
 * no atomicity, so a failing child op leaves the parent deleted and the children dangling.
 * This test does not assert that outcome is GOOD — it pins the documented weaker guarantee, so
 * that anyone replacing soft delete on a statutory entity sees the cost stated rather than
 * discovering it.
 */
describe('cascade failure between parent and child — the non-atomicity is real', () => {
  it('leaves the parent deleted when the child operation throws', async () => {
    const exploding = {
      Model: ChildModel,
      count: async () => 0,
      deleteMany: async () => {
        throw new Error('child store unavailable');
      },
    };

    const repo = new Repository(ParentModel as never, [
      methodRegistryPlugin(),
      cascadePlugin({
        relations: [{ repo: exploding as never, foreignKey: 'parent', onDelete: 'cascade' }],
      }),
    ]);

    const parent = await ParentModel.create({ name: 'p' });
    await ChildModel.create({ label: 'c', parent: parent._id });

    await expect(repo.delete(String(parent._id))).rejects.toThrow(/child store unavailable/);

    // The parent is GONE and the child survives, orphaned. This is the guarantee gap that a
    // caller-owned transaction is required to close.
    expect(await ParentModel.countDocuments({ _id: parent._id })).toBe(0);
    expect(await ChildModel.countDocuments({ parent: parent._id })).toBe(1);
  });
});

describe('TTL vs restrict', () => {
  it('THROWS when the protected parent carries a TTL index', async () => {
    const ttlParent = new Schema({ name: String, expiresAt: Date });
    ttlParent.index({ expiresAt: 1 }, { expireAfterSeconds: 60 });
    const TtlParent = await createTestModel('OnDeleteTtlParent', ttlParent);

    expect(
      () =>
        new Repository(TtlParent as never, [
          methodRegistryPlugin(),
          cascadePlugin({
            relations: [{ repo: childRepo() as never, foreignKey: 'parent', onDelete: 'restrict' }],
          }),
        ]),
    ).toThrow(/TTL index/i);
  });

  /** A TTL on the CHILD is fine — expiring children is how references legitimately drain. */
  it('allows a TTL on the CHILD side', async () => {
    const ttlChild = new Schema({ label: String, parent: { type: Schema.Types.ObjectId, index: true }, expiresAt: Date });
    ttlChild.index({ expiresAt: 1 }, { expireAfterSeconds: 60 });
    const TtlChild = await createTestModel('OnDeleteTtlChild', ttlChild);
    const ttlChildRepo = new Repository(TtlChild as never, [methodRegistryPlugin()]);

    expect(
      () =>
        new Repository(ParentModel as never, [
          methodRegistryPlugin(),
          cascadePlugin({
            relations: [{ repo: ttlChildRepo as never, foreignKey: 'parent', onDelete: 'restrict' }],
          }),
        ]),
    ).not.toThrow();
  });
});

describe('configuration validation', () => {
  it("refuses onDelete:'restrict' on the legacy model-routed form", () => {
    // The legacy path writes through `mongoose.models[...]` without the target's scoping,
    // so its count could refuse a delete on another tenant's rows.
    expect(() =>
      cascadePlugin({ relations: [{ model: 'OnDeleteChild', foreignKey: 'parent', onDelete: 'restrict' }] }),
    ).toThrow(/requires `repo`/);
  });
});
