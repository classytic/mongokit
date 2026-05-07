/**
 * `Repository.claim(id, { from, to }, patch?)` — atomic CAS state
 * transition. Standardized in `@classytic/repo-core/repository` 0.4.0;
 * mongokit ships this implementation alongside.
 *
 * Race-safe by construction: a single `findOneAndUpdate` round-trip
 * matches `{ _id, [field]: from }` and writes `{ $set: { [field]: to,
 * ...patch }}`. Returns `null` when the row's state already changed
 * (another caller won) or the row is missing.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDuplicateKeyError, Repository } from '../../src/index.js';
import { multiTenantPlugin } from '../../src/plugins/multi-tenant.plugin.js';
import { observabilityPlugin } from '../../src/plugins/observability.plugin.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRun {
  _id?: mongoose.Types.ObjectId;
  organizationId: string;
  status: 'waiting' | 'running' | 'done' | 'failed' | 'draft';
  workerId?: string;
  lastHeartbeat?: Date;
  retries?: number;
  paused?: boolean;
  retryAfter?: Date;
  steps?: Array<{ status: string; retryAfter?: Date }>;
}

interface IOrder {
  _id?: mongoose.Types.ObjectId;
  // Non-`status` state field — proves the `field` override works.
  phase: 'draft' | 'submitted' | 'approved' | 'shipped';
}

describe('Repository.claim — atomic CAS state transition', () => {
  let RunModel: mongoose.Model<IRun>;
  let OrderModel: mongoose.Model<IOrder>;

  beforeAll(async () => {
    await connectDB();
    RunModel = await createTestModel(
      'ClaimRun',
      new Schema<IRun>({
        organizationId: { type: String, required: true, index: true },
        status: { type: String, required: true },
        workerId: String,
        lastHeartbeat: Date,
        retries: Number,
        paused: Boolean,
        retryAfter: Date,
        steps: [new Schema({ status: String, retryAfter: Date }, { _id: false })],
      }),
    );
    OrderModel = await createTestModel(
      'ClaimOrder',
      new Schema<IOrder>({
        phase: { type: String, required: true },
      }),
    );
  });
  afterAll(async () => {
    await RunModel.deleteMany({});
    await OrderModel.deleteMany({});
    await disconnectDB();
  });
  beforeEach(async () => {
    await RunModel.deleteMany({});
    await OrderModel.deleteMany({});
  });

  it('transitions from→to and returns the post-update doc', async () => {
    const repo = new Repository<IRun>(RunModel);
    const created = await repo.create({ organizationId: 'org-a', status: 'waiting' });
    const id = String(created._id);

    const claimed = await repo.claim(
      id,
      { from: 'waiting', to: 'running' },
      {
        workerId: 'w-1',
        lastHeartbeat: new Date(),
      },
    );

    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe('running');
    expect(claimed?.workerId).toBe('w-1');
    expect(claimed?.lastHeartbeat).toBeInstanceOf(Date);
  });

  it('returns null when the current state does not match `from`', async () => {
    const repo = new Repository<IRun>(RunModel);
    const created = await repo.create({ organizationId: 'org-a', status: 'running' });

    // Claiming with from: 'waiting' must fail because state is 'running'.
    const claimed = await repo.claim(String(created._id), { from: 'waiting', to: 'running' });
    expect(claimed).toBeNull();

    // Doc unchanged.
    const reread = await repo.getById(String(created._id));
    expect(reread?.status).toBe('running');
  });

  it('returns null when the id does not exist', async () => {
    const repo = new Repository<IRun>(RunModel);
    const fakeId = new mongoose.Types.ObjectId();
    expect(await repo.claim(String(fakeId), { from: 'waiting', to: 'running' })).toBeNull();
  });

  it('honors a non-`status` state field via `transition.field`', async () => {
    const repo = new Repository<IOrder>(OrderModel);
    const created = await repo.create({ phase: 'draft' });
    const id = String(created._id);

    const claimed = await repo.claim(id, { field: 'phase', from: 'draft', to: 'submitted' });
    expect(claimed?.phase).toBe('submitted');

    // Wrong from-field → no match.
    const stale = await repo.claim(id, { field: 'phase', from: 'draft', to: 'shipped' });
    expect(stale).toBeNull();
  });

  it('is race-safe — exactly one of N concurrent claimers wins', async () => {
    const repo = new Repository<IRun>(RunModel);
    const created = await repo.create({ organizationId: 'org-a', status: 'waiting' });
    const id = String(created._id);

    const claimers = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        repo.claim(id, { from: 'waiting', to: 'running' }, { workerId: `w-${i}` }),
      ),
    );

    const winners = claimers.filter((r) => r !== null);
    const losers = claimers.filter((r) => r === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    expect(winners[0]?.status).toBe('running');
  });

  it('multi-tenant scope is enforced — cannot claim across tenants', async () => {
    const repo = new Repository<IRun>(RunModel, [
      multiTenantPlugin({ tenantField: 'organizationId', required: true }),
    ]);
    const created = await RunModel.create({ organizationId: 'org-a', status: 'waiting' });
    const id = String(created._id);

    // Attacker in org-b tries to claim org-a's run — must fail because
    // the tenant filter injected by multi-tenant plugin scopes the query.
    const result = await repo.claim(id, { from: 'waiting', to: 'running' }, undefined, {
      organizationId: 'org-b',
    });
    expect(result).toBeNull();

    // Same call with the correct tenant succeeds.
    const ok = await repo.claim(id, { from: 'waiting', to: 'running' }, undefined, {
      organizationId: 'org-a',
    });
    expect(ok?.status).toBe('running');
  });

  it('emits before/after:claim hooks (plugins iterating OP_REGISTRY auto-cover)', async () => {
    const onMetric = vi.fn();
    const repo = new Repository<IRun>(RunModel, [
      observabilityPlugin({ onMetric, operations: ['claim'] }),
    ]);
    const created = await repo.create({ organizationId: 'org-a', status: 'waiting' });

    await repo.claim(String(created._id), { from: 'waiting', to: 'running' });

    expect(onMetric).toHaveBeenCalledTimes(1);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'claim', success: true }),
    );
  });

  it('skipPlugins works for claim too (per-call escape hatch)', async () => {
    const onMetric = vi.fn();
    const repo = new Repository<IRun>(RunModel, [
      observabilityPlugin({ onMetric, operations: ['claim'] }),
    ]);
    const created = await repo.create({ organizationId: 'org-a', status: 'waiting' });

    await repo.claim(String(created._id), { from: 'waiting', to: 'running' }, undefined, {
      skipPlugins: ['observability'],
    });

    expect(onMetric).toHaveBeenCalledTimes(0);
  });

  describe('compound-filter claim — `transition.where`', () => {
    // Streamline's real-world audit: of 21 atomic-claim sites, 20 carry
    // compound predicates beyond `{ _id, [field]: from }`. These tests
    // mirror those exact patterns so the migration path is concrete.

    it('AND-merges paused-guard predicate (skip paused data)', async () => {
      // Streamline scheduler claim: { _id, status: 'waiting',
      //                               paused: { $ne: true } }
      const repo = new Repository<IRun>(RunModel);
      const paused = await repo.create({
        organizationId: 'org-a',
        status: 'waiting',
        paused: true,
      });
      const live = await repo.create({
        organizationId: 'org-a',
        status: 'waiting',
        paused: false,
      });

      // Paused doc — guard fails, claim returns null even though state matches.
      const blocked = await repo.claim(String(paused._id), {
        from: 'waiting',
        to: 'running',
        where: { paused: { $ne: true } },
      });
      expect(blocked).toBeNull();
      // Doc state is unchanged.
      expect((await repo.getById(String(paused._id)))?.status).toBe('waiting');

      // Live doc — guard passes, claim succeeds.
      const claimed = await repo.claim(String(live._id), {
        from: 'waiting',
        to: 'running',
        where: { paused: { $ne: true } },
      });
      expect(claimed?.status).toBe('running');
    });

    it('AND-merges retry-time guard (only fires when timer elapsed)', async () => {
      // Streamline retry claim: { _id, status: 'waiting',
      //                           retryAfter: { $lte: now } }
      const repo = new Repository<IRun>(RunModel);
      const future = new Date(Date.now() + 60_000);
      const past = new Date(Date.now() - 60_000);

      const notReady = await repo.create({
        organizationId: 'org-a',
        status: 'waiting',
        retryAfter: future,
      });
      const ready = await repo.create({
        organizationId: 'org-a',
        status: 'waiting',
        retryAfter: past,
      });

      const now = new Date();
      const tooEarly = await repo.claim(String(notReady._id), {
        from: 'waiting',
        to: 'running',
        where: { retryAfter: { $lte: now } },
      });
      expect(tooEarly).toBeNull();

      const fired = await repo.claim(String(ready._id), {
        from: 'waiting',
        to: 'running',
        where: { retryAfter: { $lte: now } },
      });
      expect(fired?.status).toBe('running');
    });

    it('AND-merges $or predicate (heartbeat-staleness recovery)', async () => {
      // Streamline stale-running recovery: { _id, status: 'running',
      //   $or: [{ lastHeartbeat: { $lt: stale } },
      //         { lastHeartbeat: { $exists: false } }] }
      const repo = new Repository<IRun>(RunModel);
      const stale = new Date(Date.now() - 5 * 60_000); // 5 min ago

      const fresh = await repo.create({
        organizationId: 'org-a',
        status: 'running',
        lastHeartbeat: new Date(),
      });
      const dead = await repo.create({
        organizationId: 'org-a',
        status: 'running',
        lastHeartbeat: new Date(Date.now() - 10 * 60_000), // 10 min ago
      });
      const neverBeat = await repo.create({
        organizationId: 'org-a',
        status: 'running',
        // lastHeartbeat omitted entirely
      });

      const recoveryWhere = {
        $or: [{ lastHeartbeat: { $lt: stale } }, { lastHeartbeat: { $exists: false } }],
      };

      // Fresh worker — guard fails, recovery is blocked (good — its work is live).
      const fail = await repo.claim(String(fresh._id), {
        from: 'running',
        to: 'waiting',
        where: recoveryWhere,
      });
      expect(fail).toBeNull();

      // Dead worker — guard matches via the $lt branch.
      const recovered = await repo.claim(String(dead._id), {
        from: 'running',
        to: 'waiting',
        where: recoveryWhere,
      });
      expect(recovered?.status).toBe('waiting');

      // Never-beat worker — guard matches via the $exists: false branch.
      const recoveredNoBeat = await repo.claim(String(neverBeat._id), {
        from: 'running',
        to: 'waiting',
        where: recoveryWhere,
      });
      expect(recoveredNoBeat?.status).toBe('waiting');
    });

    it('AND-merges $elemMatch sub-document predicate (step-ready check)', async () => {
      // Streamline step retry claim shape: { _id, status: 'waiting',
      //   steps: { $elemMatch: { status: 'pending', retryAfter: { $lte: now } } } }
      const repo = new Repository<IRun>(RunModel);
      const past = new Date(Date.now() - 60_000);
      const future = new Date(Date.now() + 60_000);

      const notReady = await repo.create({
        organizationId: 'org-a',
        status: 'waiting',
        steps: [{ status: 'pending', retryAfter: future }],
      });
      const ready = await repo.create({
        organizationId: 'org-a',
        status: 'waiting',
        steps: [
          { status: 'done' },
          { status: 'pending', retryAfter: past }, // this one is ready
        ],
      });

      const now = new Date();
      const elemWhere = {
        steps: { $elemMatch: { status: 'pending', retryAfter: { $lte: now } } },
      };

      const blocked = await repo.claim(String(notReady._id), {
        from: 'waiting',
        to: 'running',
        where: elemWhere,
      });
      expect(blocked).toBeNull();

      const fired = await repo.claim(String(ready._id), {
        from: 'waiting',
        to: 'running',
        where: elemWhere,
      });
      expect(fired?.status).toBe('running');
    });

    it('canonical CAS keys win over duplicates in `where` (defensive)', async () => {
      // Wiring-bug guard: if a caller accidentally puts the state field
      // in `where` with the wrong value, the canonical `[field]: from`
      // spread last must dominate. Otherwise a typo in `where` would
      // silently break the CAS and let stale claims through.
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'waiting' });

      const claimed = await repo.claim(String(created._id), {
        from: 'waiting',
        to: 'running',
        where: {
          // Bug: should be `from: 'waiting'` only. The canonical key
          // overrides this; the CAS still requires `status === 'waiting'`.
          status: 'something-bogus',
        },
      });
      expect(claimed?.status).toBe('running');
    });

    it('compound where + `from` mismatch → null (state guard still wins on race loss)', async () => {
      // The where predicate matches but the state field doesn't —
      // claim returns null. Same null-on-race semantics regardless of
      // which guard fails.
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({
        organizationId: 'org-a',
        status: 'running', // someone else already transitioned
        paused: false,
      });

      const result = await repo.claim(String(created._id), {
        from: 'waiting', // we expected waiting, but it's running
        to: 'done',
        where: { paused: { $ne: true } }, // this would match
      });
      expect(result).toBeNull();
    });

    it('multi-tenant scope still enforced when `where` predicates are present', async () => {
      // Plugin-injected tenant scope must AND with both `[field]: from`
      // AND `where` — no path lets a compound-filter claim escape tenant
      // isolation. The OP_REGISTRY entry for `claim` is policyKey:
      // 'query', so the plugin sees the merged filter.
      const repo = new Repository<IRun>(RunModel, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);
      const orgARun = await RunModel.create({
        organizationId: 'org-a',
        status: 'waiting',
        paused: false,
      });

      const crossTenant = await repo.claim(
        String(orgARun._id),
        {
          from: 'waiting',
          to: 'running',
          where: { paused: { $ne: true } },
        },
        undefined,
        { organizationId: 'org-b' }, // attacker
      );
      expect(crossTenant).toBeNull();

      const sameTenant = await repo.claim(
        String(orgARun._id),
        {
          from: 'waiting',
          to: 'running',
          where: { paused: { $ne: true } },
        },
        undefined,
        { organizationId: 'org-a' },
      );
      expect(sameTenant?.status).toBe('running');
    });
  });

  describe('patch operator-shape — `$inc`, `$unset`, etc.', () => {
    // Commission's audit: of 7 raw findOneAndUpdate sites, 6 needed
    // `$inc: { version: 1 }` alongside the state transition, blocking
    // claim() adoption. Yard had 0 fits for the same reason. Patch
    // accepts both flat (current ergonomic case) and operator shapes
    // (the load-bearing case for versioned data).

    it('accepts a $set + $inc operator patch (versioned-doc transition)', async () => {
      interface IVersioned {
        _id?: mongoose.Types.ObjectId;
        status: string;
        version: number;
        shippedAt?: Date;
      }
      if (mongoose.models.ClaimVersionedRun) delete mongoose.models.ClaimVersionedRun;
      const VModel = mongoose.model<IVersioned>(
        'ClaimVersionedRun',
        new Schema<IVersioned>({
          status: { type: String, required: true },
          version: { type: Number, required: true, default: 0 },
          shippedAt: Date,
        }),
      );
      await VModel.init();
      const repo = new Repository<IVersioned>(VModel);
      const created = await repo.create({ status: 'pending', version: 3 });

      const claimed = await repo.claim(
        String(created._id),
        { from: 'pending', to: 'shipped' },
        {
          $set: { shippedAt: new Date() },
          $inc: { version: 1 },
        },
      );
      expect(claimed?.status).toBe('shipped');
      expect(claimed?.version).toBe(4);
      expect(claimed?.shippedAt).toBeInstanceOf(Date);

      await VModel.deleteMany({});
    });

    it('merges caller $set with the state transition (transition wins on key collision)', async () => {
      // If a caller's $set tries to overwrite the state field with a
      // different value, the canonical transition.to must dominate.
      // Otherwise a wiring bug could silently transition to the wrong
      // state.
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'waiting' });

      const claimed = await repo.claim(
        String(created._id),
        { from: 'waiting', to: 'running' },
        {
          $set: {
            status: 'something-bogus', // wiring bug — should be ignored
            workerId: 'w-1',
          },
        },
      );
      expect(claimed?.status).toBe('running');
      expect(claimed?.workerId).toBe('w-1');
    });

    it('throws on mixed operator + flat keys (mongo would silently drop flat)', async () => {
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'waiting' });

      await expect(
        repo.claim(String(created._id), { from: 'waiting', to: 'running' }, {
          $inc: { retries: 1 },
          workerId: 'w-1', // flat key alongside $-key — bug
        } as Record<string, unknown>),
      ).rejects.toThrow(/mixes Mongo operators.*with raw field keys/);
    });

    it('passes $unset / $push / $pull through unchanged', async () => {
      // Operator passthrough — claim should not interpret operators
      // beyond merging $set with the state transition. Other operators
      // route to mongo as-is.
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({
        organizationId: 'org-a',
        status: 'waiting',
        workerId: 'old-worker', // will be unset
      });

      const claimed = await repo.claim(
        String(created._id),
        { from: 'waiting', to: 'running' },
        {
          $set: { lastHeartbeat: new Date() },
          $unset: { workerId: '' },
        },
      );
      expect(claimed?.status).toBe('running');
      expect(claimed?.workerId).toBeUndefined();
    });
  });

  describe('array `from` — multi-source CAS (`$in`)', () => {
    // Real-world frequency: commission's voidRecord / markClawedBack /
    // endAgreement / _transition all carry multi-source filters
    // ($in: [...]). Without array `from`, those sites had to fall back
    // to raw findOneAndUpdate and lose plugin routing.

    it('matches when current state is in the source array', async () => {
      const repo = new Repository<IRun>(RunModel);
      const draft = await repo.create({ organizationId: 'org-a', status: 'draft' });
      const waiting = await repo.create({ organizationId: 'org-a', status: 'waiting' });

      // "From any non-terminal state to running"
      const claimed1 = await repo.claim(String(draft._id), {
        from: ['draft', 'waiting'],
        to: 'running',
      });
      expect(claimed1?.status).toBe('running');

      const claimed2 = await repo.claim(String(waiting._id), {
        from: ['draft', 'waiting'],
        to: 'running',
      });
      expect(claimed2?.status).toBe('running');
    });

    it('returns null when current state is NOT in the source array', async () => {
      const repo = new Repository<IRun>(RunModel);
      const done = await repo.create({ organizationId: 'org-a', status: 'done' });

      const result = await repo.claim(String(done._id), {
        from: ['draft', 'waiting'],
        to: 'running',
      });
      expect(result).toBeNull();
      expect((await repo.getById(String(done._id)))?.status).toBe('done');
    });

    it('replaces the error-path findOneAndUpdate fallback', async () => {
      // media-kit's error path: catch any failure mid-upload and mark
      // status: 'error', but only for non-terminal records. Pre-array-
      // from this required `findOneAndUpdate({ status: { $in: [...] }
      // })`. Now expressible directly via claim.
      const repo = new Repository<IRun>(RunModel);
      const pending = await repo.create({ organizationId: 'org-a', status: 'waiting' });
      const ready = await repo.create({ organizationId: 'org-a', status: 'done' });

      // 'failed' is in the IRun union — using as terminal target.
      const erroredA = await repo.claim(
        String(pending._id),
        { from: ['waiting', 'running'], to: 'failed' },
        { workerId: 'errored' },
      );
      expect(erroredA?.status).toBe('failed');

      // Already terminal — must NOT be clobbered.
      const erroredB = await repo.claim(
        String(ready._id),
        { from: ['waiting', 'running'], to: 'failed' },
        { workerId: 'errored' },
      );
      expect(erroredB).toBeNull();
      expect((await repo.getById(String(ready._id)))?.status).toBe('done');
    });

    it('compounds with `where` predicates AND-merged', async () => {
      // Array from + where guard — both must hold.
      const repo = new Repository<IRun>(RunModel);
      const paused = await repo.create({
        organizationId: 'org-a',
        status: 'waiting',
        paused: true,
      });
      const live = await repo.create({
        organizationId: 'org-a',
        status: 'running',
        paused: false,
      });

      // Paused → guard fails even though state is in the source array.
      const blocked = await repo.claim(String(paused._id), {
        from: ['waiting', 'running'],
        to: 'done',
        where: { paused: { $ne: true } },
      });
      expect(blocked).toBeNull();

      // Not paused, state in array → claim succeeds.
      const claimed = await repo.claim(String(live._id), {
        from: ['waiting', 'running'],
        to: 'done',
        where: { paused: { $ne: true } },
      });
      expect(claimed?.status).toBe('done');
    });

    it('canonical state-field key wins over duplicates in `where` (array form)', async () => {
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'waiting' });

      // Wiring bug: where puts status with the wrong predicate. The
      // canonical [stateField]: $in[...] spreads last and wins.
      const claimed = await repo.claim(String(created._id), {
        from: ['waiting', 'running'],
        to: 'done',
        where: { status: 'something-bogus' },
      });
      expect(claimed?.status).toBe('done');
    });
  });

  describe('from === to optimization — skip redundant state-field write', () => {
    // Under high-replay workloads (yard's gate-event.append, outbox
    // dedup storms, idempotent first-write CAS), `from === to` writes
    // `$set: { [stateField]: to }` over a value that the filter
    // already pinned — provably redundant. The optimization drops
    // the no-op write, saving disk + journal + replication-log per
    // replay.

    function captureClaimUpdate(repo: Repository<IRun>): {
      current: Record<string, unknown> | undefined;
    } {
      const captured: { current: Record<string, unknown> | undefined } = { current: undefined };
      repo.on('before:claim', (ctx: { data?: Record<string, unknown> }) => {
        captured.current = ctx.data;
      });
      return captured;
    }

    it('drops the redundant state-field $set with empty patch + non-upsert (lowers to findOne)', async () => {
      const repo = new Repository<IRun>(RunModel);
      const captured = captureClaimUpdate(repo);
      const created = await repo.create({ organizationId: 'org-a', status: 'running' });

      const result = await repo.claim(String(created._id), { from: 'running', to: 'running' });

      expect(result?.status).toBe('running');
      // Verify the constructed update is empty — no `$set` at all.
      expect(captured.current).toEqual({});
    });

    it('returns null on miss for the empty-patch findOne fast path', async () => {
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'done' });

      const result = await repo.claim(String(created._id), { from: 'running', to: 'running' });
      expect(result).toBeNull();
    });

    it('drops the redundant state-field key but keeps caller patch fields (flat patch)', async () => {
      const repo = new Repository<IRun>(RunModel);
      const captured = captureClaimUpdate(repo);
      const created = await repo.create({ organizationId: 'org-a', status: 'running' });

      const result = await repo.claim(
        String(created._id),
        { from: 'running', to: 'running' },
        { workerId: 'w-new', lastHeartbeat: new Date() },
      );

      expect(result?.workerId).toBe('w-new');
      expect(result?.lastHeartbeat).toBeInstanceOf(Date);
      // The constructed $set has caller fields ONLY — NO `status: 'running'`
      // entry, since from === to means the filter already pins it.
      const set = (captured.current as { $set?: Record<string, unknown> }).$set;
      expect(set).toBeDefined();
      expect(set).not.toHaveProperty('status');
      expect(set).toHaveProperty('workerId', 'w-new');
    });

    it('drops the redundant state-field $set entry from operator patches with empty $set', async () => {
      // `from === to` + operator patch like `{ $inc: { retries: 1 } }`
      // — the redundant `$set: { status: to }` should NOT be added,
      // and the $inc passes through untouched.
      const repo = new Repository<IRun>(RunModel);
      const captured = captureClaimUpdate(repo);
      const created = await repo.create({
        organizationId: 'org-a',
        status: 'running',
        retries: 0,
      });

      const result = await repo.claim(
        String(created._id),
        { from: 'running', to: 'running' },
        { $inc: { retries: 1 } },
      );

      expect(result?.retries).toBe(1);
      expect(result?.status).toBe('running');
      // No $set in the constructed update — only $inc.
      expect(captured.current).not.toHaveProperty('$set');
      expect(captured.current).toHaveProperty('$inc', { retries: 1 });
    });

    it('drops the redundant state-field key from operator patches with caller $set', async () => {
      const repo = new Repository<IRun>(RunModel);
      const captured = captureClaimUpdate(repo);
      const created = await repo.create({
        organizationId: 'org-a',
        status: 'running',
        retries: 0,
      });

      await repo.claim(
        String(created._id),
        { from: 'running', to: 'running' },
        {
          $set: { workerId: 'w-1' },
          $inc: { retries: 1 },
        },
      );

      const set = (captured.current as { $set?: Record<string, unknown> }).$set;
      expect(set).toEqual({ workerId: 'w-1' }); // status is NOT here
      expect((captured.current as { $inc?: Record<string, unknown> }).$inc).toEqual({ retries: 1 });
    });

    it('still writes the state field when from !== to (control)', async () => {
      // Sanity check: optimization fires only on from===to. Normal
      // transitions still get the full $set.
      const repo = new Repository<IRun>(RunModel);
      const captured = captureClaimUpdate(repo);
      const created = await repo.create({ organizationId: 'org-a', status: 'waiting' });

      await repo.claim(String(created._id), { from: 'waiting', to: 'running' });

      const set = (captured.current as { $set?: Record<string, unknown> }).$set;
      expect(set).toEqual({ status: 'running' });
    });

    it('still writes when `from` is an array (multi-source — actual value may differ from `to`)', async () => {
      // Array form is unsafe to optimize: filter matches via $in, so
      // the actual current value could be any of the array members.
      // We still need $set: { status: to } to converge to the target.
      const repo = new Repository<IRun>(RunModel);
      const captured = captureClaimUpdate(repo);
      const created = await repo.create({ organizationId: 'org-a', status: 'waiting' });

      await repo.claim(String(created._id), {
        from: ['waiting', 'running'],
        to: 'running', // includes 'running' which matches one $in branch
      });

      const set = (captured.current as { $set?: Record<string, unknown> }).$set;
      expect(set).toEqual({ status: 'running' });
    });

    it('actually skips the disk write — uses findOne (not findOneAndUpdate) for empty-patch replay', async () => {
      // Black-box verification: spy on the underlying mongoose calls.
      // Empty-patch + from===to + non-upsert MUST route through
      // `Model.findOne` and NOT `Model.findOneAndUpdate`. That's the
      // whole point of the optimization — no journal flush, no
      // replication-log entry, no `updatedAt` bump.
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'running' });
      const id = String(created._id);

      const findOneSpy = vi.spyOn(RunModel, 'findOne');
      const findOneAndUpdateSpy = vi.spyOn(RunModel, 'findOneAndUpdate');

      const result = await repo.claim(id, { from: 'running', to: 'running' });

      expect(result?.status).toBe('running');
      expect(findOneSpy).toHaveBeenCalledTimes(1);
      expect(findOneAndUpdateSpy).not.toHaveBeenCalled();

      findOneSpy.mockRestore();
      findOneAndUpdateSpy.mockRestore();
    });

    it('with non-empty patch + from===to: still routes through findOneAndUpdate (writes are needed)', async () => {
      // Sanity-check the inverse: the optimization ONLY skips the
      // findOneAndUpdate when the post-optimization update is empty.
      // A non-empty patch still needs the write round-trip.
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'running' });
      const id = String(created._id);

      const findOneSpy = vi.spyOn(RunModel, 'findOne');
      const findOneAndUpdateSpy = vi.spyOn(RunModel, 'findOneAndUpdate');

      await repo.claim(id, { from: 'running', to: 'running' }, { workerId: 'w-1' });

      expect(findOneAndUpdateSpy).toHaveBeenCalledTimes(1);
      expect(findOneSpy).not.toHaveBeenCalled();

      findOneSpy.mockRestore();
      findOneAndUpdateSpy.mockRestore();
    });
  });

  describe('pure-dedup upsert (yard `gate-event.append` shape)', () => {
    // The canonical pattern: `idField === stateField`, `from === to ===
    // id`, `upsert: true`, empty patch. On miss → insert. On replay →
    // return existing doc with NO disk write.
    //
    // The optimization swaps the redundant `$set: { [stateField]: to }`
    // for `$setOnInsert: { [stateField]: to }`, which only writes on
    // insert. Replay path is then a true zero-write read.

    interface IGateEvent {
      _id?: mongoose.Types.ObjectId;
      externalEventId: string;
      receivedAt?: Date;
    }

    let GateModel: mongoose.Model<IGateEvent>;

    beforeAll(async () => {
      GateModel = await createTestModel(
        'GateEventDedup',
        new Schema<IGateEvent>({
          externalEventId: { type: String, required: true, unique: true },
          receivedAt: Date,
        }),
      );
    });

    afterAll(async () => {
      await GateModel.deleteMany({});
    });

    beforeEach(async () => {
      await GateModel.deleteMany({});
    });

    it('inserts on first call, returns existing on replay with empty patch (no second write)', async () => {
      // The canonical pattern: empty patch on every call. First call
      // inserts (with `$setOnInsert: { externalEventId: 'evt-001' }`
      // + filter-literal merge). Replay matches — `$setOnInsert` is
      // a no-op on match. NO second write.
      const repo = new Repository<IGateEvent>(GateModel);

      const first = await repo.claim(
        'evt-001',
        { field: 'externalEventId', from: 'evt-001', to: 'evt-001' },
        {},
        { idField: 'externalEventId', upsert: true },
      );
      expect(first).not.toBeNull();
      expect(first?.externalEventId).toBe('evt-001');
      const insertedId = first?._id?.toString();

      // Spy AFTER the insert to verify the replay does no write op.
      const findOneAndUpdateSpy = vi.spyOn(GateModel, 'findOneAndUpdate');

      const replay = await repo.claim(
        'evt-001',
        { field: 'externalEventId', from: 'evt-001', to: 'evt-001' },
        {},
        { idField: 'externalEventId', upsert: true },
      );

      // findOneAndUpdate IS still called (we need upsert semantics
      // for first-write CAS), but with `$setOnInsert` only — mongo's
      // wire path is: match → return existing doc, no write applied.
      // The win is the elided `$set: { [stateField]: to }` work that
      // would otherwise journal-write on every replay.
      expect(findOneAndUpdateSpy).toHaveBeenCalledTimes(1);
      const callArgs = findOneAndUpdateSpy.mock.calls[0];
      const updateDoc = callArgs?.[1] as Record<string, unknown>;
      // Confirm $setOnInsert sentinel — no $set.
      expect(updateDoc).toHaveProperty('$setOnInsert');
      expect(updateDoc).not.toHaveProperty('$set');

      expect(replay?._id?.toString()).toBe(insertedId);
      expect(await GateModel.countDocuments()).toBe(1);

      findOneAndUpdateSpy.mockRestore();
    });

    it('caller-supplied insert-only payload via $setOnInsert is preserved across replays', async () => {
      // For the "insert-only payload" pattern, callers pass their
      // payload via `$setOnInsert` directly. Replay returns the
      // existing doc with the original payload intact — replay-time
      // values do NOT clobber.
      const repo = new Repository<IGateEvent>(GateModel);
      const insertTime = new Date('2026-01-01T00:00:00Z');

      const first = await repo.claim(
        'evt-002',
        { field: 'externalEventId', from: 'evt-002', to: 'evt-002' },
        { $setOnInsert: { receivedAt: insertTime } },
        { idField: 'externalEventId', upsert: true },
      );
      expect(first?.receivedAt?.getTime()).toBe(insertTime.getTime());

      // Replay with a different receivedAt in $setOnInsert — must
      // NOT overwrite (the $setOnInsert only fires on insert; on
      // match, it's a no-op).
      const replay = await repo.claim(
        'evt-002',
        { field: 'externalEventId', from: 'evt-002', to: 'evt-002' },
        { $setOnInsert: { receivedAt: new Date('2030-01-01T00:00:00Z') } },
        { idField: 'externalEventId', upsert: true },
      );
      expect(replay?.receivedAt?.getTime()).toBe(insertTime.getTime());
      expect(await GateModel.countDocuments()).toBe(1);
    });

    it('uses $setOnInsert (not $set) for the empty-patch upsert path', async () => {
      const repo = new Repository<IGateEvent>(GateModel);
      let captured: Record<string, unknown> | undefined;
      repo.on('before:claim', (ctx: { data?: Record<string, unknown> }) => {
        // Snapshot via structuredClone — mongoose's `findOneAndUpdate`
        // mutates the update document in-place with version-key
        // bookkeeping (`$setOnInsert.__v = 0` on upsert). Capturing the
        // raw reference here would surface that mutation in our
        // assertion below, even though it happens AFTER the hook fires.
        captured = structuredClone(ctx.data ?? {});
      });

      await repo.claim(
        'evt-002',
        { field: 'externalEventId', from: 'evt-002', to: 'evt-002' },
        {},
        { idField: 'externalEventId', upsert: true },
      );

      // Constructed update is `{ $setOnInsert: { externalEventId: 'evt-002' } }`
      // — NOT `{ $set: { externalEventId: 'evt-002' } }`. On replay,
      // $setOnInsert is a no-op (no disk write).
      expect(captured).toEqual({ $setOnInsert: { externalEventId: 'evt-002' } });
      expect(captured).not.toHaveProperty('$set');
    });
  });

  describe('dotted-path `field` — nested state columns', () => {
    // Nested-state shapes are common: lpn.state, package.condition.state,
    // scheduling.status. Mongo handles dotted paths in both filter and
    // $set; mongokit just passes the path string through. Lock it in
    // with explicit tests so future refactors can't quietly break it.

    interface INestedRun {
      _id?: mongoose.Types.ObjectId;
      scheduling: { status: string; retryAfter?: Date };
      payload?: string;
    }

    let NestedModel: mongoose.Model<INestedRun>;

    beforeAll(async () => {
      NestedModel = await createTestModel(
        'ClaimNestedRun',
        new Schema<INestedRun>({
          scheduling: new Schema({ status: String, retryAfter: Date }, { _id: false }),
          payload: String,
        }),
      );
    });
    afterAll(async () => {
      await NestedModel.deleteMany({});
    });
    beforeEach(async () => {
      await NestedModel.deleteMany({});
    });

    it('matches and writes via dotted-path field', async () => {
      const repo = new Repository<INestedRun>(NestedModel);
      const created = await repo.create({
        scheduling: { status: 'queued' },
      });

      const claimed = await repo.claim(
        String(created._id),
        { field: 'scheduling.status', from: 'queued', to: 'running' },
        { payload: 'work-1' },
      );
      expect(claimed?.scheduling.status).toBe('running');
      expect(claimed?.payload).toBe('work-1');
    });

    it('returns null on dotted-path state mismatch (CAS still works)', async () => {
      const repo = new Repository<INestedRun>(NestedModel);
      const created = await repo.create({
        scheduling: { status: 'done' },
      });

      const result = await repo.claim(String(created._id), {
        field: 'scheduling.status',
        from: 'queued',
        to: 'running',
      });
      expect(result).toBeNull();
    });

    it('honors from === to optimization on dotted-path (no redundant write)', async () => {
      const repo = new Repository<INestedRun>(NestedModel);
      let captured: Record<string, unknown> | undefined;
      repo.on('before:claim', (ctx: { data?: Record<string, unknown> }) => {
        captured = ctx.data;
      });
      const created = await repo.create({
        scheduling: { status: 'running' },
      });

      // Empty patch + from === to + dotted path → empty update,
      // findOne fast path.
      const findOneSpy = vi.spyOn(NestedModel, 'findOne');
      const findOneAndUpdateSpy = vi.spyOn(NestedModel, 'findOneAndUpdate');

      await repo.claim(String(created._id), {
        field: 'scheduling.status',
        from: 'running',
        to: 'running',
      });

      expect(captured).toEqual({});
      expect(findOneSpy).toHaveBeenCalledTimes(1);
      expect(findOneAndUpdateSpy).not.toHaveBeenCalled();

      findOneSpy.mockRestore();
      findOneAndUpdateSpy.mockRestore();
    });

    it('drops redundant dotted-path key from $set when from === to + content patch', async () => {
      const repo = new Repository<INestedRun>(NestedModel);
      let captured: Record<string, unknown> | undefined;
      repo.on('before:claim', (ctx: { data?: Record<string, unknown> }) => {
        captured = ctx.data;
      });
      const created = await repo.create({
        scheduling: { status: 'running' },
      });

      await repo.claim(
        String(created._id),
        { field: 'scheduling.status', from: 'running', to: 'running' },
        { payload: 'extra' },
      );

      // $set has only `payload` — no `scheduling.status` key.
      const set = (captured as { $set?: Record<string, unknown> }).$set;
      expect(set).toEqual({ payload: 'extra' });
      expect(set).not.toHaveProperty('scheduling.status');
    });
  });

  describe('assertNoMixedPatchShape — error message + stack trace anchor', () => {
    it('error message names the helper so stack traces point at the rule', async () => {
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'waiting' });

      let caught: Error | undefined;
      try {
        await repo.claim(String(created._id), { from: 'waiting', to: 'running' }, {
          $inc: { retries: 1 },
          workerId: 'w-1', // flat key alongside $-key — bug
        } as Record<string, unknown>);
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).toBeDefined();
      // The error message names the validator function so debugging is
      // grep-friendly. The "Mongo would silently DROP" framing makes
      // the data-loss risk explicit.
      expect(caught?.message).toMatch(/assertNoMixedPatchShape/);
      expect(caught?.message).toMatch(/silently DROP/);
      expect(caught?.message).toMatch(/operators.*flat keys|flat keys.*operators/);
    });
  });

  describe('idempotent same-state CAS — `from === to`', () => {
    // Yard's reviseDeparture: 'departed' → 'departed' to update the
    // payload while asserting the row hasn't moved on. The CAS still
    // returns null on race-loss, so the safety property holds.

    it('writes the patch and returns the doc when state matches', async () => {
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({
        organizationId: 'org-a',
        status: 'running',
        workerId: 'old-worker',
      });

      // Re-claim 'running' → 'running' with a payload update.
      const reclaimed = await repo.claim(
        String(created._id),
        { from: 'running', to: 'running' },
        { workerId: 'new-worker', lastHeartbeat: new Date() },
      );
      expect(reclaimed?.status).toBe('running');
      expect(reclaimed?.workerId).toBe('new-worker');
    });

    it('returns null when state has moved away (race still detected)', async () => {
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'done' });

      const reclaimed = await repo.claim(
        String(created._id),
        { from: 'running', to: 'running' },
        { workerId: 'late' },
      );
      expect(reclaimed).toBeNull();
    });
  });

  describe('upsert-claim — `options.upsert: true`', () => {
    // Yard's gate-event.append pattern: insert if missing, else CAS-
    // transition the existing row. Without upsert support claim was
    // pure-CAS (null on miss), forcing the upsert-claim sites back to
    // raw findOneAndUpdate.

    it('inserts when the row does not exist', async () => {
      const repo = new Repository<IRun>(RunModel);
      const newId = new mongoose.Types.ObjectId();

      const inserted = await repo.claim(
        String(newId),
        { from: 'waiting', to: 'running' },
        {
          $set: { workerId: 'w-1' },
          $setOnInsert: { organizationId: 'org-a', retries: 0 },
        },
        { upsert: true },
      );
      expect(inserted).not.toBeNull();
      expect(inserted?.status).toBe('running'); // $set landed
      expect(inserted?.workerId).toBe('w-1');
      expect(inserted?.retries).toBe(0); // $setOnInsert landed
      expect(inserted?.organizationId).toBe('org-a');
    });

    it('CAS-transitions when the row exists and matches `from`', async () => {
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'waiting' });

      const claimed = await repo.claim(
        String(created._id),
        { from: 'waiting', to: 'running' },
        { $setOnInsert: { retries: 99 } }, // would land only on insert
        { upsert: true },
      );
      expect(claimed?.status).toBe('running');
      expect(claimed?.retries).toBeUndefined(); // $setOnInsert didn't fire
    });

    it('returns the existing row unchanged when `from` does not match (upsert + CAS-loss)', async () => {
      // With upsert: true and a state mismatch, mongo would normally
      // try to insert a new doc with the same _id — that fails with
      // E11000 duplicate key. The driver throws; mongokit surfaces
      // the duplicate-key signal so callers can detect "row exists
      // but didn't transition" via the standard error classifier.
      const repo = new Repository<IRun>(RunModel);
      const created = await repo.create({ organizationId: 'org-a', status: 'done' });

      // Try to claim 'waiting' → 'running' on a 'done' row, with upsert.
      // The state filter doesn't match, so upsert kicks in and tries
      // to insert with the same _id → E11000.
      let caught: Error | undefined;
      try {
        await repo.claim(
          String(created._id),
          { from: 'waiting', to: 'running' },
          {},
          { upsert: true },
        );
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeDefined();
      expect(isDuplicateKeyError(caught)).toBe(true);
      // Original row unchanged.
      expect((await repo.getById(String(created._id)))?.status).toBe('done');
    });

    it('default (upsert undefined) keeps null-on-miss semantic', async () => {
      const repo = new Repository<IRun>(RunModel);
      const fakeId = new mongoose.Types.ObjectId();

      const result = await repo.claim(String(fakeId), { from: 'waiting', to: 'running' });
      expect(result).toBeNull();
    });
  });

  it('returns null on a structurally invalid ObjectId — same miss-semantic as getById/update/delete', async () => {
    // Pre-fix: claim built `{ [idField]: id, ... }` with no shape guard,
    // so `claim('bad-id', ...)` against an ObjectId `_id` would let
    // mongoose attempt the cast and surface a CastError. Existing
    // ID-based paths (getById / update / delete) all return null on
    // invalid-shape ids — this guard restores parity for claim.
    const repo = new Repository<IRun>(RunModel);

    const result = await repo.claim('bad-id-not-an-objectid', { from: 'waiting', to: 'running' });
    expect(result).toBeNull();
  });
});
