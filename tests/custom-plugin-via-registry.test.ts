/**
 * Custom plugin contract — end-to-end validation that third-party plugin
 * authors can build on the same surface bundled plugins use.
 *
 * This file doubles as executable documentation: it shows the canonical
 * shape of a custom plugin that drives its hook registration from
 * OP_REGISTRY / ALL_OPERATIONS, and proves the contract works for ops
 * the plugin author has never explicitly named (including future ops
 * added after the plugin was written).
 */

import mongoose, { Schema, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_OPERATIONS,
  HOOK_PRIORITY,
  MUTATING_OPERATIONS,
  OP_REGISTRY,
  Repository,
  multiTenantPlugin,
  type Plugin,
  type RepositoryContext,
  type RepositoryInstance,
  type RepositoryOperation,
} from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface ICustomPluginDoc {
  _id: Types.ObjectId;
  name: string;
  organizationId?: string;
  rowVersion?: number;
}

const CustomPluginSchema = new Schema<ICustomPluginDoc>({
  name: { type: String, required: true },
  organizationId: String,
  rowVersion: { type: Number, default: 0 },
});

// ────────────────────────────────────────────────────────────────────────────
// Custom plugin #1 — RowVersionPlugin
//
// Increments a `rowVersion` field on every mutating operation that targets
// a single document by filter. Drives its op list from MUTATING_OPERATIONS
// + OP_REGISTRY classification — so when a future mutating op lands in the
// registry, this plugin auto-picks it up.
// ────────────────────────────────────────────────────────────────────────────

function rowVersionPlugin(): Plugin {
  return {
    name: 'rowVersion',
    apply(repo: RepositoryInstance): void {
      for (const op of MUTATING_OPERATIONS) {
        const desc = OP_REGISTRY[op];
        // Only hook ops whose primary input is a single update payload.
        // Skip create/createMany (rowVersion is initialized via schema default),
        // bulkWrite (multi-op shape), updateMany/deleteMany (multi-doc).
        if (desc.policyKey !== 'query') continue;
        if (op === 'delete' || op === 'restore') continue;

        repo.on(
          `before:${op}`,
          (context: RepositoryContext) => {
            const data = context.data as Record<string, unknown> | undefined;
            if (!data) return;
            // Pipeline-style updates (array) — user controls timestamps + version.
            if (Array.isArray(data)) return;

            // Always use $inc so the version is incremented based on the
            // doc's current rowVersion in the DB, not the plugin's local
            // bookkeeping. For plain-object payloads ({ name: 'x' }), wrap
            // them in $set so $inc can coexist.
            const isOperatorStyle = Object.keys(data).some((k) => k.startsWith('$'));
            if (!isOperatorStyle) {
              const setFields = { ...data };
              for (const k of Object.keys(data)) delete data[k];
              data.$set = setFields;
            }
            const inc = (data.$inc as Record<string, unknown>) || {};
            inc.rowVersion = ((inc.rowVersion as number) || 0) + 1;
            data.$inc = inc;
          },
          { priority: HOOK_PRIORITY.DEFAULT },
        );
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Custom plugin #2 — OperationCounterPlugin
//
// Increments a counter for every operation the registry knows about. Proves
// ALL_OPERATIONS is enumerable and exhaustive at runtime.
// ────────────────────────────────────────────────────────────────────────────

function operationCounterPlugin(counters: Record<string, number>): Plugin {
  return {
    name: 'operationCounter',
    apply(repo: RepositoryInstance): void {
      for (const op of ALL_OPERATIONS) {
        repo.on(`after:${op}`, () => {
          counters[op] = (counters[op] || 0) + 1;
        });
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('custom plugin built on OP_REGISTRY', () => {
  let Model: mongoose.Model<ICustomPluginDoc>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('CustomPluginRegistry', CustomPluginSchema);
  });

  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
  });

  describe('rowVersionPlugin (MUTATING_OPERATIONS-driven)', () => {
    it('increments rowVersion on update (registry classification: policyKey=query, mutates=true)', async () => {
      const repo = new Repository(Model, [rowVersionPlugin()]);
      const seed = await Model.create({ name: 'doc-1', rowVersion: 0 });

      const updated = await repo.update(seed._id.toString(), { name: 'doc-1-v2' });
      expect(updated.rowVersion).toBe(1);

      await repo.update(seed._id.toString(), { name: 'doc-1-v3' });
      const reread = await Model.findById(seed._id).lean();
      expect(reread?.rowVersion).toBe(2);
    });

    it('increments rowVersion on findOneAndUpdate WITHOUT the plugin author having named the op', async () => {
      // The plugin author wrote `for (const op of MUTATING_OPERATIONS)`.
      // findOneAndUpdate is in MUTATING_OPERATIONS by virtue of its
      // registry entry. The plugin auto-picks it up — proving the
      // single-source-of-truth contract.
      const repo = new Repository(Model, [rowVersionPlugin()]);
      const seed = await Model.create({ name: 'cas-doc', rowVersion: 0 });

      const result = await repo.findOneAndUpdate(
        { _id: seed._id },
        { $set: { name: 'cas-v2' } },
      );

      expect(result?.rowVersion).toBe(1);
    });

    it('does not touch creates (rowVersion initialized via schema default)', async () => {
      const repo = new Repository(Model, [rowVersionPlugin()]);
      const created = await repo.create({ name: 'fresh' });
      expect(created.rowVersion).toBe(0);
    });
  });

  describe('operationCounterPlugin (ALL_OPERATIONS-driven)', () => {
    it('hooks every registered op via ALL_OPERATIONS — no manual list', async () => {
      const counters: Record<string, number> = {};
      const repo = new Repository(Model, [operationCounterPlugin(counters)]);

      // Exercise a representative slice. The point isn't completeness here —
      // it's that ALL_OPERATIONS contained these names without the plugin
      // author hardcoding them.
      await repo.create({ name: 'op-1' });
      const seed = await Model.create({ name: 'op-2' });
      await repo.getById(seed._id.toString());
      await repo.findAll({ name: 'op-2' });
      await repo.update(seed._id.toString(), { name: 'op-2-v2' });
      await repo.findOneAndUpdate({ _id: seed._id }, { $set: { name: 'op-2-v3' } });
      await repo.count({});
      await repo.delete(seed._id.toString());

      expect(counters.create).toBe(1);
      expect(counters.getById).toBe(1);
      expect(counters.findAll).toBe(1);
      expect(counters.update).toBe(1);
      expect(counters.findOneAndUpdate).toBe(1);
      expect(counters.count).toBe(1);
      expect(counters.delete).toBe(1);
    });

    it('exposes the same op set bundled plugins use (parity check)', () => {
      // If a future op lands in RepositoryOperation but is missed in
      // OP_REGISTRY, every registry-driven plugin (this one and all
      // bundled plugins) becomes silently incomplete. The op-registry
      // unit tests guard against that — this is a runtime sanity check
      // from the consumer perspective.
      const allOps = new Set(ALL_OPERATIONS);
      // Sanity: a few ops a custom plugin author would expect to find.
      for (const op of [
        'create',
        'update',
        'findOneAndUpdate',
        'delete',
        'getAll',
        'findAll',
      ] as RepositoryOperation[]) {
        expect(allOps.has(op), `ALL_OPERATIONS missing ${op}`).toBe(true);
      }
    });
  });

  describe('composition with bundled plugins (ordering, no interference)', () => {
    it('custom plugin runs alongside multi-tenant — both see the right context', async () => {
      const counters: Record<string, number> = {};
      const repo = new Repository(Model, [
        multiTenantPlugin(),
        operationCounterPlugin(counters),
        rowVersionPlugin(),
      ]);

      // Multi-tenant should scope by org; counter sees the after hook;
      // rowVersion should still increment on findOneAndUpdate.
      await Model.create([
        { name: 'org1', organizationId: 'org_1', rowVersion: 0 },
        { name: 'org2', organizationId: 'org_2', rowVersion: 0 },
      ]);

      const result = await repo.findOneAndUpdate(
        { name: { $in: ['org1', 'org2'] } },
        { $set: { name: 'mutated' } },
        { organizationId: 'org_1' },
      );

      // Multi-tenant scoped to org_1 — must match org1, not org2.
      expect(result).not.toBeNull();
      const reread = await Model.findById(result?._id).lean();
      expect(reread?.organizationId).toBe('org_1');
      expect(reread?.rowVersion).toBe(1);

      // Counter recorded the after:findOneAndUpdate hook firing.
      expect(counters.findOneAndUpdate).toBe(1);
    });
  });
});
