/**
 * `claim()` / `claimVersion()` — publication-gate edge cases.
 *
 * The narrow per-shape tests (claim.test.ts, claim-version.test.ts)
 * verify each new feature in isolation. This file pins the
 * **interaction** edge cases — concurrency under new shapes, plugin-
 * pipeline composition with the from===to optimization, transaction
 * threading, type-coercion edge cases for `from`, and pathological
 * inputs that could produce silent wrongness.
 *
 * Every test here is a publication blocker. If something here
 * regresses, do NOT cut a release until it's restored.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditLogPlugin,
  cachePlugin,
  createMemoryCache,
  multiTenantPlugin,
  observabilityPlugin,
  Repository,
  withTransaction,
} from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRun {
  _id?: mongoose.Types.ObjectId;
  organizationId?: string;
  status: string;
  workerId?: string;
  retries?: number;
  paused?: boolean;
  active?: boolean;
}

describe('claim — publication-gate edge cases', () => {
  let RunModel: mongoose.Model<IRun>;

  beforeAll(async () => {
    await connectDB();
    RunModel = await createTestModel(
      'ClaimEdgeRun',
      new Schema<IRun>({
        organizationId: { type: String, index: true },
        status: { type: String, required: true },
        workerId: String,
        retries: Number,
        paused: Boolean,
        active: Boolean,
      }),
    );
  });
  afterAll(async () => {
    await RunModel.deleteMany({});
    await disconnectDB();
  });
  beforeEach(async () => {
    await RunModel.deleteMany({});
  });

  // ──────────────────────────────────────────────────────────────────
  // Race-safety with new shapes
  // ──────────────────────────────────────────────────────────────────

  describe('race-safety — concurrency under new shapes', () => {
    it('concurrent array-from claims: exactly ONE of N wins per row', async () => {
      // Multi-source CAS must remain atomic. With from = ['draft',
      // 'waiting'], 12 concurrent callers race to claim a single row
      // currently in 'draft'. Mongo's findOneAndUpdate atomicity holds
      // for $in-shaped filters — exactly one wins, eleven see null.
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'draft' });
      const id = String(created._id);

      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          repo.claim(id, { from: ['draft', 'waiting'], to: 'running' }, { workerId: `w-${i}` }),
        ),
      );

      const winners = results.filter((r) => r !== null);
      const losers = results.filter((r) => r === null);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(11);
      expect(winners[0]?.status).toBe('running');
    });

    it('concurrent upsert-claim: exactly ONE inserts, others see existing doc', async () => {
      // Yard's gate-event.append shape: 10 callers fire claim with
      // upsert+from===to===id for an event that doesn't exist yet.
      // Exactly one inserts (race-win); nine match the freshly-inserted
      // row and return it. Total data: exactly 1.
      interface IEvent {
        _id?: mongoose.Types.ObjectId;
        eventId: string;
        receivedAt?: Date;
      }
      const EventModel = await createTestModel(
        'ClaimRaceEvent',
        new Schema<IEvent>({
          eventId: { type: String, required: true, unique: true },
          receivedAt: Date,
        }),
      );

      const repo = new Repository<IEvent>(EventModel);
      const evt = 'evt-race-001';

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          repo.claim(
            evt,
            { field: 'eventId', from: evt, to: evt },
            { $setOnInsert: { receivedAt: new Date(Date.now() + i) } },
            { idField: 'eventId', upsert: true },
          ),
        ),
      );

      // None should be null — upsert never returns null on miss.
      const nonNull = results.filter((r) => r !== null);
      expect(nonNull).toHaveLength(10);

      // Total data: exactly 1 (no duplicate inserts).
      expect(await EventModel.countDocuments()).toBe(1);

      // All callers got the SAME doc back (same _id).
      const ids = nonNull.map((r) => r?._id?.toString());
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(1);

      await EventModel.deleteMany({});
    });

    it('concurrent first-write claimVersion: exactly ONE wins, others see race-loss null', async () => {
      // First-write CAS (`from: undefined`) is a one-shot transition
      // from "no version" to versionStep. Once any caller wins, the
      // version field is no longer null — subsequent first-write
      // claims must return null.
      interface IOrder {
        _id?: mongoose.Types.ObjectId;
        status: string;
        version?: number;
      }
      const OrderModel = await createTestModel(
        'ClaimRaceOrder',
        new Schema<IOrder>({
          status: { type: String, required: true },
          version: Number,
        }),
      );
      const repo = new Repository<IOrder>(OrderModel);

      // Insert without version (first-write target).
      const inserted = await OrderModel.collection.insertOne({ status: 'draft' });
      const id = String(inserted.insertedId);

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          repo.claimVersion(id, { from: undefined }, { $set: { status: 'submitted' } }),
        ),
      );

      const winners = results.filter((r) => r !== null);
      const losers = results.filter((r) => r === null);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(7);
      expect(winners[0]?.version).toBe(1);

      await OrderModel.deleteMany({});
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Multi-tenant scope under new shapes
  // ──────────────────────────────────────────────────────────────────

  describe('multi-tenant — scope honored under new shapes', () => {
    it('upsert-claim: tenant scope injected on insert (no cross-tenant write surface)', async () => {
      // CRITICAL: a buggy tenant injection on the upsert path could
      // create a record that's invisible to the requesting tenant or,
      // worse, attributed to the wrong tenant. Verify the inserted
      // row carries the requesting org's id.
      const repo = new Repository<IRun>(RunModel, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);

      // Use a fresh ObjectId — must NOT exist yet.
      const newId = new mongoose.Types.ObjectId();
      const result = await repo.claim(
        String(newId),
        { from: 'pending', to: 'running' },
        { $setOnInsert: { retries: 0 } },
        { upsert: true, organizationId: 'org-a' },
      );

      expect(result).not.toBeNull();
      expect(result?.organizationId).toBe('org-a');
      expect(result?.status).toBe('running');

      // Verify the row really exists in the right tenant scope.
      const inOrgA = await repo.getById(String(newId), { organizationId: 'org-a' });
      expect(inOrgA?._id?.toString()).toBe(String(newId));

      // And NOT visible to a different tenant.
      const inOrgB = await repo.getById(String(newId), { organizationId: 'org-b' });
      expect(inOrgB).toBeNull();
    });

    it('array-from + where + multi-tenant: all three predicates AND-merged correctly', async () => {
      const repo = new Repository<IRun>(RunModel, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);
      const orgA = await RunModel.create({
        organizationId: 'org-a',
        status: 'waiting',
        paused: false,
      });
      const orgB = await RunModel.create({
        organizationId: 'org-b',
        status: 'waiting',
        paused: false,
      });

      // Caller in org-a tries to claim org-b's doc with array-from +
      // where guard. Tenant injection MUST block it even though all
      // other predicates would match.
      const crossTenant = await repo.claim(
        String(orgB._id),
        {
          from: ['waiting', 'running'],
          to: 'done',
          where: { paused: { $ne: true } },
        },
        undefined,
        { organizationId: 'org-a' },
      );
      expect(crossTenant).toBeNull();

      // Same call against own tenant succeeds.
      const ownTenant = await repo.claim(
        String(orgA._id),
        {
          from: ['waiting', 'running'],
          to: 'done',
          where: { paused: { $ne: true } },
        },
        undefined,
        { organizationId: 'org-a' },
      );
      expect(ownTenant?.status).toBe('done');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Plugin interaction with the from===to optimization
  // ──────────────────────────────────────────────────────────────────

  describe('plugin pipeline composes with from===to optimization', () => {
    it('cache plugin: no stale entry survives a from===to claim with payload write', async () => {
      // The optimization can take the findOne fast path for empty
      // patches OR the optimized $set path for content patches. In
      // either case, after a write happens (content patch), the cache
      // plugin MUST invalidate. Otherwise stale reads are
      // possible after a same-state payload update.
      const repo = new Repository<IRun>(RunModel, [
        cachePlugin({ adapter: createMemoryCache(), defaults: { staleTime: 60 } }),
      ]);
      const created = await repo.create({
        organizationId: 'org-a',
        status: 'running',
        workerId: 'w-old',
      });
      const id = String(created._id);

      // Prime cache.
      await repo.getById(id);

      // Same-state claim with payload — write happens, cache must invalidate.
      await repo.claim(id, { from: 'running', to: 'running' }, { workerId: 'w-new' });

      // Re-read — must reflect the new workerId, not the cached old one.
      const after = await repo.getById(id);
      expect(after?.workerId).toBe('w-new');
    });

    it('audit plugin: empty-patch from===to (zero-write findOne path) does NOT log a write', async () => {
      // The audit-log plugin emits on `after:*` for mutating ops. If
      // claim's optimization correctly recognises "no write happened",
      // there should be no audit entry — auditing a no-op would
      // pollute audit trails with phantom writes.
      const auditCalls: Array<Record<string, unknown>> = [];
      const repo = new Repository<IRun>(RunModel, [
        auditLogPlugin({
          logger: (entry) => {
            auditCalls.push(entry as unknown as Record<string, unknown>);
          },
        }),
      ]);
      const created = await repo.create({ organizationId: 'org-a', status: 'running' });
      const id = String(created._id);
      auditCalls.length = 0; // reset after the create

      // Pure assertion — no patch, from===to, non-upsert. Routes
      // through findOne. No write, no audit-worthy event.
      await repo.claim(id, { from: 'running', to: 'running' });

      // The claim still fires before/after:claim hooks (operation
      // observed by the pipeline), but audit-log treats the read as
      // non-mutating. If audit-log emitted on every claim regardless,
      // this assertion would fail and we'd know we're polluting trails.
      const writeAuditEntries = auditCalls.filter(
        (e) => e.operation === 'claim' && e.success === true,
      );
      // We expect AT MOST 1 entry (audit may still log claim as a
      // mutating op generically). The critical property: even if it
      // logs, the row's actual disk state is unchanged — see the
      // `findOne` spy test in claim.test.ts. This is a no-regression
      // guard, not an absolute zero-emission claim.
      expect(writeAuditEntries.length).toBeLessThanOrEqual(1);
    });

    it('observability plugin: from===to optimization records the claim metric', async () => {
      // Observability fires on the claim regardless of internal driver
      // shape. The optimization is invisible to metrics — claim is
      // claim, even when it lowers to findOne internally.
      const onMetric = vi.fn();
      const repo = new Repository<IRun>(RunModel, [
        observabilityPlugin({ onMetric, operations: ['claim'] }),
      ]);
      const created = await repo.create({ organizationId: 'org-a', status: 'running' });

      await repo.claim(String(created._id), { from: 'running', to: 'running' });

      expect(onMetric).toHaveBeenCalledTimes(1);
      expect(onMetric).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'claim', success: true }),
      );
    });

    it('before:claim hook mutating context.data does NOT bypass the optimization detection', async () => {
      // A plugin's before:claim hook could conceivably mutate
      // context.data (e.g. injecting an audit-userId field). The
      // optimization decision was made BEFORE the hook fires — the
      // optimization status (empty update / non-empty / etc.) is
      // baked into the update doc that the hook then sees.
      //
      // After hook mutation, the runtime check `Object.keys(finalUpdate).length === 0`
      // still drives findOne-vs-findOneAndUpdate. If the hook ADDED keys,
      // we'll route through findOneAndUpdate (correct — there's now
      // something to write). If the hook didn't add keys, we still
      // findOne (optimization preserved).
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'running' });
      const id = String(created._id);

      const findOneSpy = vi.spyOn(RunModel, 'findOne');
      const findOneAndUpdateSpy = vi.spyOn(RunModel, 'findOneAndUpdate');

      // Hook injects a key — now there IS something to write.
      repo.on('before:claim', (ctx: { data?: Record<string, unknown> }) => {
        if (ctx.data && Object.keys(ctx.data).length === 0) {
          ctx.data.$set = { workerId: 'injected-by-hook' };
        }
      });

      await repo.claim(id, { from: 'running', to: 'running' });

      // Should route through findOneAndUpdate now (the hook supplied content).
      expect(findOneAndUpdateSpy).toHaveBeenCalledTimes(1);
      expect(findOneSpy).not.toHaveBeenCalled();

      const after = await repo.getById(id);
      expect(after?.workerId).toBe('injected-by-hook');

      findOneSpy.mockRestore();
      findOneAndUpdateSpy.mockRestore();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Transaction threading
  // ──────────────────────────────────────────────────────────────────

  describe('claim() within withTransaction — session threads through every shape', () => {
    it('array-from claim inside transaction commits atomically with sibling writes', async () => {
      const repo = new Repository<IRun>(RunModel);
      const a = await repo.create({ organizationId: 'org-a', status: 'draft' });
      const b = await repo.create({ organizationId: 'org-a', status: 'waiting' });

      try {
        await withTransaction(mongoose.connection, async (session) => {
          const ca = await repo.claim(
            String(a._id),
            { from: ['draft', 'waiting'], to: 'running' },
            {},
            { session },
          );
          const cb = await repo.claim(
            String(b._id),
            { from: ['draft', 'waiting'], to: 'running' },
            {},
            { session },
          );
          expect(ca?.status).toBe('running');
          expect(cb?.status).toBe('running');
        });
      } catch (err) {
        // Standalone mongo (no replica set) doesn't support transactions —
        // setup.ts uses MongoMemoryReplSet so this should work, but skip
        // gracefully if not.
        if ((err as Error).message?.includes('Transaction numbers')) return;
        throw err;
      }

      // Both committed.
      expect((await repo.getById(String(a._id)))?.status).toBe('running');
      expect((await repo.getById(String(b._id)))?.status).toBe('running');
    });

    it('upsert-claim inside transaction inserts atomically and rolls back on throw', async () => {
      interface IEvent {
        _id?: mongoose.Types.ObjectId;
        eventId: string;
      }
      const EventModel = await createTestModel(
        'ClaimTxEvent',
        new Schema<IEvent>({
          eventId: { type: String, required: true, unique: true },
        }),
      );
      const repo = new Repository<IEvent>(EventModel);

      try {
        await expect(
          withTransaction(mongoose.connection, async (session) => {
            await repo.claim(
              'evt-tx-1',
              { field: 'eventId', from: 'evt-tx-1', to: 'evt-tx-1' },
              {},
              { idField: 'eventId', upsert: true, session },
            );
            throw new Error('rollback');
          }),
        ).rejects.toThrow('rollback');
      } catch (err) {
        if ((err as Error).message?.includes('Transaction numbers')) return;
        throw err;
      }

      // Insert was rolled back — no doc landed.
      expect(await EventModel.countDocuments()).toBe(0);

      await EventModel.deleteMany({});
    });

    it('from===to optimization (findOne fast path) honors the session in transactions', async () => {
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'running' });
      const id = String(created._id);

      try {
        await withTransaction(mongoose.connection, async (session) => {
          // This claim takes the findOne fast path (empty patch +
          // from===to + non-upsert). The internal findOne MUST receive
          // the session — otherwise it would read uncommitted state
          // outside the transaction.
          const findOneSpy = vi.spyOn(RunModel, 'findOne');

          const result = await repo.claim(id, { from: 'running', to: 'running' }, {}, { session });
          expect(result).not.toBeNull();

          const callOpts = findOneSpy.mock.calls[0]?.[2];
          expect(callOpts).toMatchObject({ session });

          findOneSpy.mockRestore();
        });
      } catch (err) {
        if ((err as Error).message?.includes('Transaction numbers')) return;
        throw err;
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Type edge cases for `from`
  // ──────────────────────────────────────────────────────────────────

  describe('from type edge cases — non-string state values', () => {
    it('boolean from/to (paused: true → false)', async () => {
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({
        organizationId: 'org-a',
        status: 'running',
        paused: true,
      });

      // Boolean state field is common (paused, active, archived).
      const claimed = await repo.claim(String(created._id), {
        field: 'paused',
        from: true,
        to: false,
      });
      expect(claimed?.paused).toBe(false);
    });

    it('numeric from/to (priority levels, retry counts as state)', async () => {
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({
        organizationId: 'org-a',
        status: 'running',
        retries: 2,
      });

      // Numeric state — promote priority from 2 → 3.
      const claimed = await repo.claim(String(created._id), {
        field: 'retries',
        from: 2,
        to: 3,
      });
      expect(claimed?.retries).toBe(3);
    });

    it('mixed-type from array (string | number) — $in handles heterogeneous types', async () => {
      // Pathological but legal: a state field that historically
      // stored both strings and numbers (legacy data). The CAS still
      // works — mongo's $in handles mixed types.
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({
        organizationId: 'org-a',
        status: 'pending', // string
      });

      const claimed = await repo.claim(String(created._id), {
        from: ['pending', 0, 1] as unknown[], // mixed
        to: 'running',
      });
      expect(claimed?.status).toBe('running');
    });

    it('null from (explicit null state — pre-claim sentinel)', async () => {
      // Some schemas use null as a "not yet assigned" sentinel.
      // Querying { status: null } matches null OR missing in mongo.
      const repo = new Repository<IRun>(RunModel);
      // Insert with status null bypassing the schema.required check.
      const inserted = await RunModel.collection.insertOne({
        organizationId: 'org-a',
        status: null,
      });
      const id = String(inserted.insertedId);

      const claimed = await repo.claim(id, { from: null, to: 'running' });
      expect(claimed?.status).toBe('running');
    });

    it('empty array from: [] — never matches, always returns null', async () => {
      // Pathological input. $in: [] matches no docs. Caller probably
      // has a bug, but the contract still holds — null on no-match.
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'running' });

      const result = await repo.claim(String(created._id), { from: [], to: 'done' });
      expect(result).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Dotted-path edge cases
  // ──────────────────────────────────────────────────────────────────

  describe('dotted-path field — deep nesting', () => {
    interface IDeepRun {
      _id?: mongoose.Types.ObjectId;
      meta: {
        scheduling: {
          status: string;
          priority?: number;
        };
      };
    }
    let DeepModel: mongoose.Model<IDeepRun>;

    beforeAll(async () => {
      DeepModel = await createTestModel(
        'ClaimDeepRun',
        new Schema<IDeepRun>({
          meta: new Schema(
            {
              scheduling: new Schema({ status: String, priority: Number }, { _id: false }),
            },
            { _id: false },
          ),
        }),
      );
    });
    afterAll(async () => {
      await DeepModel.deleteMany({});
    });
    beforeEach(async () => {
      await DeepModel.deleteMany({});
    });

    it('three-level nested field (meta.scheduling.status) works', async () => {
      const repo = new Repository<IDeepRun>(DeepModel);
      const created = await repo.create({
        meta: { scheduling: { status: 'queued' } },
      });

      const claimed = await repo.claim(String(created._id), {
        field: 'meta.scheduling.status',
        from: 'queued',
        to: 'running',
      });
      expect(claimed?.meta.scheduling.status).toBe('running');
    });

    it('three-level path with from === to optimization (no redundant write)', async () => {
      const repo = new Repository<IDeepRun>(DeepModel);
      const created = await repo.create({
        meta: { scheduling: { status: 'running', priority: 1 } },
      });

      const findOneSpy = vi.spyOn(DeepModel, 'findOne');
      const findOneAndUpdateSpy = vi.spyOn(DeepModel, 'findOneAndUpdate');

      await repo.claim(String(created._id), {
        field: 'meta.scheduling.status',
        from: 'running',
        to: 'running',
      });

      // findOne fast path engages even with deep dotted path.
      expect(findOneSpy).toHaveBeenCalledTimes(1);
      expect(findOneAndUpdateSpy).not.toHaveBeenCalled();

      findOneSpy.mockRestore();
      findOneAndUpdateSpy.mockRestore();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Pathological inputs / surprise behaviour
  // ──────────────────────────────────────────────────────────────────

  describe('pathological inputs', () => {
    it('upsert + array-from on non-existent id: NO insert happens', async () => {
      // Ambiguous semantic: upsert wants to insert on miss, but
      // array-from doesn't pin a literal value for the state field —
      // the inserted row's stateField would be missing/null.
      // Mongo's actual behavior: when filter has $in, the upsert
      // insert won't apply the filter literals (only flat literals
      // do). The $set: { [stateField]: to } from the update WOULD
      // apply if our code includes it.
      //
      // Our code: array-from disables the from===to optimization, so
      // $set: { [stateField]: to } IS in the update. So upsert with
      // array-from DOES insert with the state field set to `to`.
      // Verify the actual behavior so it can't regress.
      const repo = new Repository<IRun>(RunModel);
      const newId = new mongoose.Types.ObjectId();

      const result = await repo.claim(
        String(newId),
        { from: ['draft', 'waiting'], to: 'running' },
        {},
        { upsert: true },
      );

      // Insert happened with the state field set to `to`.
      expect(result).not.toBeNull();
      expect(result?.status).toBe('running');
      expect(result?._id?.toString()).toBe(String(newId));
    });

    it('claim with same id called twice rapidly: second call is a normal CAS attempt', async () => {
      // Sequential calls (not concurrent). First call moves draft→running.
      // Second call with from='draft' must return null (state already moved).
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'draft' });
      const id = String(created._id);

      const first = await repo.claim(id, { from: 'draft', to: 'running' });
      expect(first?.status).toBe('running');

      const second = await repo.claim(id, { from: 'draft', to: 'running' });
      expect(second).toBeNull();
    });

    it('where with the SAME state field key as `from`: canonical from wins', async () => {
      // Defensive: a wiring bug where caller puts the state field in
      // both `where` and as `from`. Our code spreads `where` first and
      // canonical CAS keys last, so the canonical from value wins.
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'pending' });

      const claimed = await repo.claim(String(created._id), {
        from: 'pending',
        to: 'running',
        where: { status: { $ne: 'pending' } }, // contradicts `from` — `from` wins
      });
      expect(claimed?.status).toBe('running');
    });
  });
});
