/**
 * Plugin coverage for Repository.findOneAndUpdate
 *
 * Sister suite to findOneAndUpdate.test.ts. The base suite proves the
 * primitive works end-to-end; this one proves every bundled plugin that
 * touches mutating ops is wired to findOneAndUpdate too. If someone adds
 * a future mutating op and forgets a plugin, these tests fail loudly.
 */

import mongoose, { Schema, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Repository,
  auditLogPlugin,
  auditTrailPlugin,
  cachePlugin,
  createMemoryCache,
  observabilityPlugin,
  validationChainPlugin,
} from '../src/index.js';
import type { OperationMetric } from '../src/plugins/observability.plugin.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface IFoauPluginDoc {
  _id: Types.ObjectId;
  status: string;
  payload: string;
  organizationId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const FoauPluginSchema = new Schema<IFoauPluginDoc>({
  status: { type: String, default: 'pending' },
  payload: { type: String, required: true },
  organizationId: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
});

describe('findOneAndUpdate — plugin coverage', () => {
  let Model: mongoose.Model<IFoauPluginDoc>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('FoauPluginCoverage', FoauPluginSchema);
  });

  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
  });

  // ─────────────────────────────────────────────────────────────────────
  // auditLogPlugin
  // ─────────────────────────────────────────────────────────────────────

  describe('auditLogPlugin', () => {
    it('logs after:findOneAndUpdate with the matched document id', async () => {
      const info = vi.fn();
      const error = vi.fn();
      const repo = new Repository(Model, [
        auditLogPlugin({
          info,
          error,
          warn: vi.fn(),
          debug: vi.fn(),
        }),
      ]);

      const seed = await Model.create({ payload: 'audit-log', status: 'pending' });
      await repo.findOneAndUpdate({ _id: seed._id }, { $set: { status: 'done' } });

      const findOneCall = info.mock.calls.find(
        ([msg]) => typeof msg === 'string' && msg.includes('findOneAndUpdate'),
      );
      expect(findOneCall).toBeDefined();
      expect(findOneCall?.[1]?.id?.toString()).toBe(seed._id.toString());
    });

    it('does not log when filter matches nothing (null result)', async () => {
      const info = vi.fn();
      const repo = new Repository(Model, [
        auditLogPlugin({
          info,
          error: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
        }),
      ]);

      const result = await repo.findOneAndUpdate(
        { payload: 'never-matches' },
        { $set: { status: 'done' } },
      );

      expect(result).toBeNull();
      const findOneCall = info.mock.calls.find(
        ([msg]) => typeof msg === 'string' && msg.includes('findOneAndUpdate'),
      );
      expect(findOneCall).toBeUndefined();
    });

    it('logs error:findOneAndUpdate on driver errors', async () => {
      const error = vi.fn();
      const repo = new Repository(Model, [
        auditLogPlugin({
          info: vi.fn(),
          error,
          warn: vi.fn(),
          debug: vi.fn(),
        }),
      ]);

      await expect(
        repo.findOneAndUpdate({ _id: 'not-an-objectid' }, { $set: { status: 'x' } }),
      ).rejects.toThrow();

      const errCall = error.mock.calls.find(
        ([msg]) => typeof msg === 'string' && msg.includes('findOneAndUpdate failed'),
      );
      expect(errCall).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // auditTrailPlugin
  // ─────────────────────────────────────────────────────────────────────

  describe('auditTrailPlugin', () => {
    const AUDIT_COLL = 'audit_trails_foau_coverage';

    async function readAuditEntries(): Promise<Record<string, unknown>[]> {
      // Fire-and-forget writes — give them a tick to land.
      await new Promise((r) => setTimeout(r, 200));
      return mongoose.connection
        .collection(AUDIT_COLL)
        .find({})
        .toArray() as Promise<Record<string, unknown>[]>;
    }

    beforeEach(async () => {
      try {
        await mongoose.connection.collection(AUDIT_COLL).deleteMany({});
      } catch {}
    });

    it('does not track findOneAndUpdate by default (opt-in op)', async () => {
      const repo = new Repository(Model, [
        auditTrailPlugin({ collectionName: AUDIT_COLL }),
      ]);
      const seed = await Model.create({ payload: 'no-track', status: 'pending' });
      await repo.findOneAndUpdate({ _id: seed._id }, { $set: { status: 'done' } });

      const entries = await readAuditEntries();
      const foauEntries = entries.filter((e) => e.operation === 'findOneAndUpdate');
      expect(foauEntries).toHaveLength(0);
    });

    it('tracks findOneAndUpdate when included in operations', async () => {
      const repo = new Repository(Model, [
        auditTrailPlugin({
          operations: ['findOneAndUpdate'],
          collectionName: AUDIT_COLL,
        }),
      ]);

      const seed = await Model.create({ payload: 'tracked', status: 'pending' });
      await repo.findOneAndUpdate({ _id: seed._id }, { $set: { status: 'done' } });

      const entries = await readAuditEntries();
      const foau = entries.find((e) => e.operation === 'findOneAndUpdate');
      expect(foau).toBeDefined();
      expect(foau?.documentId?.toString()).toBe(seed._id.toString());
    });

    it('skips audit when filter matches nothing (null result)', async () => {
      const repo = new Repository(Model, [
        auditTrailPlugin({
          operations: ['findOneAndUpdate'],
          collectionName: AUDIT_COLL,
        }),
      ]);

      await repo.findOneAndUpdate(
        { payload: 'never-matches' },
        { $set: { status: 'done' } },
      );

      const entries = await readAuditEntries();
      const foau = entries.filter((e) => e.operation === 'findOneAndUpdate');
      expect(foau).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // observabilityPlugin
  // ─────────────────────────────────────────────────────────────────────

  describe('observabilityPlugin', () => {
    it('records a metric for findOneAndUpdate by default', async () => {
      const onMetric = vi.fn<(m: OperationMetric) => void>();
      const repo = new Repository(Model, [observabilityPlugin({ onMetric })]);

      const seed = await Model.create({ payload: 'metric', status: 'pending' });
      await repo.findOneAndUpdate({ _id: seed._id }, { $set: { status: 'done' } });

      const calls = onMetric.mock.calls.filter(([m]) => m.operation === 'findOneAndUpdate');
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0][0].success).toBe(true);
      expect(calls[0][0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('records failure metric on driver errors', async () => {
      const onMetric = vi.fn<(m: OperationMetric) => void>();
      const repo = new Repository(Model, [observabilityPlugin({ onMetric })]);

      await expect(
        repo.findOneAndUpdate({ _id: 'not-an-objectid' }, { $set: { status: 'x' } }),
      ).rejects.toThrow();

      const failures = onMetric.mock.calls.filter(
        ([m]) => m.operation === 'findOneAndUpdate' && m.success === false,
      );
      expect(failures.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // cachePlugin
  // ─────────────────────────────────────────────────────────────────────

  describe('cachePlugin', () => {
    it('serves fresh value via getById after findOneAndUpdate (cache invalidated)', async () => {
      const adapter = createMemoryCache();
      const repo = new Repository(Model, [cachePlugin({ adapter, ttl: 60, debug: false })]);

      const seed = await Model.create({ payload: 'cached', status: 'pending' });

      // Prime the cache via getById — second call should be a cache hit.
      const first = await repo.getById(seed._id.toString());
      expect(first.status).toBe('pending');

      // Second read — comes from cache (we don't observe this directly, but
      // it sets up the test: if cache invalidation is broken, the next read
      // after findOneAndUpdate will return the stale 'pending' value).
      await repo.getById(seed._id.toString());

      // CAS update — must invalidate by ID + bump version so subsequent
      // reads see the new value, not the cached pre-update one.
      await repo.findOneAndUpdate({ _id: seed._id }, { $set: { status: 'done' } });

      const fresh = await repo.getById(seed._id.toString());
      expect(fresh.status).toBe('done');
    });

    it('does not throw on null match (no doc, after:findOneAndUpdate cache hook is a safe no-op)', async () => {
      const adapter = createMemoryCache();
      const repo = new Repository(Model, [cachePlugin({ adapter, ttl: 60, debug: false })]);

      const result = await repo.findOneAndUpdate(
        { payload: 'no-match' },
        { $set: { status: 'done' } },
      );
      expect(result).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // validationChainPlugin
  // ─────────────────────────────────────────────────────────────────────

  describe('validationChainPlugin', () => {
    it('runs validators registered for findOneAndUpdate', async () => {
      const calls: string[] = [];
      const repo = new Repository(Model, [
        validationChainPlugin([
          {
            name: 'block-done',
            operations: ['findOneAndUpdate'],
            validate: (ctx) => {
              calls.push('ran');
              const data = ctx.data as Record<string, unknown> | undefined;
              const set = data?.$set as Record<string, unknown> | undefined;
              if (set?.status === 'forbidden') {
                throw new Error('status "forbidden" is not allowed');
              }
            },
          },
        ]),
      ]);

      const seed = await Model.create({ payload: 'validated', status: 'pending' });

      // Allowed update — validator runs, passes.
      await repo.findOneAndUpdate({ _id: seed._id }, { $set: { status: 'done' } });
      expect(calls).toEqual(['ran']);

      // Forbidden update — validator runs, throws.
      await expect(
        repo.findOneAndUpdate({ _id: seed._id }, { $set: { status: 'forbidden' } }),
      ).rejects.toThrow(/forbidden/);
      expect(calls).toEqual(['ran', 'ran']);
    });

    it('does not run update-only validators on findOneAndUpdate', async () => {
      const updateOnlyCalls: string[] = [];
      const repo = new Repository(Model, [
        validationChainPlugin([
          {
            name: 'update-only',
            operations: ['update'],
            validate: () => {
              updateOnlyCalls.push('ran');
            },
          },
        ]),
      ]);

      const seed = await Model.create({ payload: 'scoped', status: 'pending' });
      await repo.findOneAndUpdate({ _id: seed._id }, { $set: { status: 'done' } });

      expect(updateOnlyCalls).toEqual([]);
    });
  });
});
