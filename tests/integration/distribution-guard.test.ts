/**
 * `options.distribution` — the shard-key guard `@classytic/repo-core` ships
 * (`createDistributionGuard`), wired into every filter-taking verb.
 *
 * The check runs AFTER `before:*` hooks, so a tenant scope injected by
 * `multiTenantPlugin` satisfies a `key: 'organizationId'` guard and the
 * guard only fires on the calls that dropped the scope — `bypassTenant`,
 * an unscoped repo, an empty filter.
 *
 * Id-addressed verbs (`getById`, `update`, `delete`, `claim*`, `restore`) are
 * checked too, UNLESS the distribution key is the id field — an `_id` match is
 * routed only when `_id` is what the collection is sharded on.
 */

import { eq } from '@classytic/repo-core/filter';
import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogger, multiTenantPlugin, Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IDoc {
  _id?: mongoose.Types.ObjectId;
  organizationId: string;
  status: string;
  name: string;
}

const THROW = { key: 'organizationId', onMissingKey: 'throw' } as const;

describe('distribution guard (shard-key awareness)', () => {
  let Model: mongoose.Model<IDoc>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'DistributionGuardDoc',
      new Schema<IDoc>({
        organizationId: { type: String, required: true, index: true },
        status: { type: String, required: true },
        name: { type: String, required: true },
      }),
    );
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });
  beforeEach(async () => {
    await Model.deleteMany({});
    await Model.create([
      { organizationId: 'org-a', status: 'active', name: 'A' },
      { organizationId: 'org-b', status: 'active', name: 'B' },
    ]);
  });

  const strict = () => new Repository<IDoc>(Model, [], {}, { distribution: THROW });

  describe("onMissingKey: 'throw'", () => {
    it('rejects findAll whose filter omits the key on an unscoped repo', async () => {
      await expect(strict().findAll({ status: 'active' })).rejects.toThrow(
        /Distribution guard: findAll filter omits the distribution key "organizationId"/,
      );
    });

    it('passes when the caller filter carries the key — including inside $or', async () => {
      const repo = strict();
      await expect(
        repo.findAll({ organizationId: 'org-a', status: 'active' }),
      ).resolves.toHaveLength(1);
      await expect(
        repo.count({ $or: [{ organizationId: 'org-a' }, { organizationId: 'org-b' }] }),
      ).resolves.toBe(2);
    });

    it('passes when multiTenantPlugin injected the key the caller omitted', async () => {
      const repo = new Repository<IDoc>(
        Model,
        [multiTenantPlugin({ tenantField: 'organizationId' })],
        {},
        { distribution: THROW },
      );
      const rows = await repo.findAll({ status: 'active' }, { organizationId: 'org-a' });
      expect(rows.map((r) => r.name)).toEqual(['A']);
    });

    it('still checks a bypassTenant: true call — the scatter-gather the guard exists for', async () => {
      const repo = new Repository<IDoc>(
        Model,
        [multiTenantPlugin({ tenantField: 'organizationId' })],
        {},
        { distribution: THROW },
      );
      await expect(repo.findAll({ status: 'active' }, { bypassTenant: true })).rejects.toThrow(
        /Distribution guard: findAll/,
      );
    });

    it('covers every filter-taking verb', async () => {
      const repo = strict();
      await expect(repo.getAll({ filters: { status: 'active' } })).rejects.toThrow(/getAll filter/);
      await expect(repo.getOne({ status: 'active' })).rejects.toThrow(/getOne filter/);
      await expect(repo.getByQuery({ status: 'active' })).rejects.toThrow(/getByQuery filter/);
      await expect(repo.count({ status: 'active' })).rejects.toThrow(/count filter/);
      await expect(repo.exists({ status: 'active' })).rejects.toThrow(/exists filter/);
      await expect(repo.distinct('name', { status: 'active' })).rejects.toThrow(/distinct filter/);
      await expect(repo.updateMany({ status: 'active' }, { $set: { name: 'x' } })).rejects.toThrow(
        /updateMany filter/,
      );
      await expect(repo.deleteMany({ status: 'active' })).rejects.toThrow(/deleteMany filter/);
      await expect(
        repo.findOneAndUpdate({ status: 'active' }, { $set: { name: 'x' } }),
      ).rejects.toThrow(/findOneAndUpdate filter/);
      await expect(
        repo.aggregatePipeline([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      ).rejects.toThrow(/aggregatePipeline filter/);
      await expect(repo.aggregate({ measures: { n: { op: 'count' } } })).rejects.toThrow(
        /aggregate filter/,
      );
      // An empty filter misses too — `count()` with no args fans out.
      await expect(repo.count()).rejects.toThrow(/count filter/);
      // cursor is an async generator — the throw surfaces on the first pull.
      await expect(
        (async () => {
          for await (const _doc of repo.cursor({ status: 'active' })) {
            // drain
          }
        })(),
      ).rejects.toThrow(/cursor filter/);
    });

    it('reads the key from the portable aggregate filter and from a leading $match', async () => {
      const repo = strict();
      const { rows } = await repo.aggregate<{ n: number }>({
        filter: eq('organizationId', 'org-a'),
        measures: { n: { op: 'count' } },
      });
      expect(rows[0]?.n).toBe(1);

      const grouped = await repo.aggregatePipeline<{ _id: string; n: number }>([
        { $match: { organizationId: 'org-b' } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]);
      expect(grouped).toEqual([{ _id: 'active', n: 1 }]);
    });

    /**
     * Id-addressed verbs were originally exempt, on the reasoning that "the
     * `_id` match is routed, not scattered". That holds only when `_id` IS the
     * shard key. Sharded on `organizationId` — the tenant design this guard
     * mostly exists for — a by-id update is a broadcast to every shard, and
     * MongoDB before 7.0 rejected `updateOne`/`deleteOne` without the shard
     * key outright. So they are guarded too, and the exemption is now keyed off
     * the CONFIG rather than the verb.
     */
    it('checks id-addressed verbs when the shard key is NOT the id field', async () => {
      const repo = strict();
      const a = await Model.findOne({ name: 'A' }).lean();
      const id = String(a?._id);

      await expect(repo.getById(id)).rejects.toThrow(/getById filter omits/);
      await expect(repo.update(id, { name: 'A2' })).rejects.toThrow(/update filter omits/);
      await expect(repo.delete(id)).rejects.toThrow(/delete filter omits/);
      // Refused, not silently broadcast — the document is untouched.
      expect((await Model.findById(id).lean())?.name).toBe('A');
    });

    it('a scoped by-id write satisfies the guard — only the unscoped one is flagged', async () => {
      const repo = strict();
      const a = await Model.findOne({ name: 'A' }).lean();
      const id = String(a?._id);

      // The key rides the same `query` slot tenant scope lands in, so a
      // correctly-scoped write passes and reaches exactly one shard.
      await expect(
        repo.update(id, { name: 'A2' }, { query: { organizationId: 'org-a' } }),
      ).resolves.toMatchObject({ name: 'A2' });
    });

    it('multiTenantPlugin satisfies it for by-id writes too', async () => {
      // The realistic wiring: nobody passes the key by hand, the plugin
      // injects it — and the guard runs after hooks, so it sees it.
      const repo = new Repository<IDoc>(
        Model,
        [multiTenantPlugin({ tenantField: 'organizationId' })],
        {},
        { distribution: THROW },
      );
      const a = await Model.findOne({ name: 'A' }).lean();
      const id = String(a?._id);

      await expect(
        repo.update(id, { name: 'A2' }, { organizationId: 'org-a' }),
      ).resolves.toMatchObject({ name: 'A2' });
      await expect(repo.update(id, { name: 'A3' }, { bypassTenant: true })).rejects.toThrow(
        /update filter omits/,
      );
    });

    it('leaves id-addressed verbs alone when the shard key IS the id field', async () => {
      // Here the original reasoning is sound: an `_id` match is routed. The
      // guard must not fire on every by-id call, which would be pure noise.
      const repo = new Repository<IDoc>(
        Model,
        [],
        {},
        { distribution: { key: '_id', onMissingKey: 'throw' } },
      );
      const a = await Model.findOne({ name: 'A' }).lean();
      const id = String(a?._id);

      await expect(repo.getById(id)).resolves.toMatchObject({ name: 'A' });
      await expect(repo.update(id, { name: 'A2' })).resolves.toMatchObject({ name: 'A2' });
      await expect(repo.delete(id)).resolves.toMatchObject({ id });
    });

    /**
     * Geospatial filters go through the same check as any other — the guard
     * asks only whether the distribution key appears, and never inspects the
     * operator. Worth pinning because `$near` is the case where being flagged
     * is MOST correct: MongoDB does not support `$near`/`$nearSphere` on a
     * sharded collection at all.
     */
    it('reads the key out of a leading $geoNear.query — the sharded proximity search', async () => {
      // `$geoNear` must be the first stage and hides its predicate in `query`,
      // the one filter slot that is not a `$match`. It is also the SUPPORTED
      // way to run proximity on a sharded collection ($near is rejected
      // there), so a miss here would warn on the geo query that routed
      // correctly while staying quiet about the one that did not.
      const repo = strict();
      await expect(
        repo.aggregatePipeline([
          {
            $geoNear: {
              near: { type: 'Point', coordinates: [0, 0] },
              distanceField: 'distance',
              query: { organizationId: 'org-a' },
            },
          },
        ]),
      ).rejects.toThrow(/unable to find index|2dsphere/i);

      await expect(
        repo.aggregatePipeline([
          {
            $geoNear: {
              near: { type: 'Point', coordinates: [0, 0] },
              distanceField: 'distance',
              query: { status: 'active' },
            },
          },
        ]),
      ).rejects.toThrow(/aggregatePipeline filter omits/);
    });

    it('treats a geo filter like any other — the key is what matters, not the operator', async () => {
      const repo = strict();
      // `$geoWithin`, not `$near`: Mongo refuses `$near` in a count (it needs a
      // sort) and refuses it on a sharded collection entirely, which is the
      // same reason an unscoped geo query deserves flagging in the first place.
      const within = {
        location: { $geoWithin: { $centerSphere: [[0, 0], 0.01] } },
      };

      await expect(repo.count(within)).rejects.toThrow(/count filter omits/);
      // Same geo predicate, tenant-scoped → routed, so it passes untouched.
      await expect(repo.count({ ...within, organizationId: 'org-a' })).resolves.toBe(0);
    });

    it('skips operations listed in exemptOperations', async () => {
      const repo = new Repository<IDoc>(
        Model,
        [],
        {},
        { distribution: { ...THROW, exemptOperations: ['findAll'] } },
      );
      await expect(repo.findAll({ status: 'active' })).resolves.toHaveLength(2);
      await expect(repo.count({ status: 'active' })).rejects.toThrow(/count filter/);
    });
  });

  describe("onMissingKey: 'warn' (the default)", () => {
    it('logs once per operation through the mongokit logger and proceeds', async () => {
      const warnSpy = vi.fn();
      configureLogger({ warn: warnSpy });
      try {
        const repo = new Repository<IDoc>(
          Model,
          [],
          {},
          { distribution: { key: 'organizationId' } },
        );
        await expect(repo.findAll({ status: 'active' })).resolves.toHaveLength(2);
        await expect(repo.findAll({ status: 'active' })).resolves.toHaveLength(2);
        await expect(repo.count({ status: 'active' })).resolves.toBe(2);

        const guardWarnings = warnSpy.mock.calls
          .map(([message]) => String(message))
          .filter((m) => m.includes('distribution key'));
        expect(guardWarnings).toHaveLength(2);
        expect(guardWarnings[0]).toMatch(
          /Repository "DistributionGuardDoc": findAll filter omits the distribution key "organizationId"/,
        );
        expect(guardWarnings[1]).toMatch(/: count filter omits/);
      } finally {
        configureLogger({ warn: console.warn.bind(console) });
      }
    });

    it('routes every first miss to onMiss when supplied', async () => {
      const onMiss = vi.fn();
      const repo = new Repository<IDoc>(
        Model,
        [],
        {},
        { distribution: { key: 'organizationId', onMiss } },
      );
      await expect(repo.findAll({ status: 'active' })).resolves.toHaveLength(2);
      expect(onMiss).toHaveBeenCalledTimes(1);
      expect(onMiss).toHaveBeenCalledWith({ operation: 'findAll', key: 'organizationId' });
    });
  });

  it("onMissingKey: 'off' and an absent option both leave every verb untouched", async () => {
    const off = new Repository<IDoc>(
      Model,
      [],
      {},
      { distribution: { key: 'organizationId', onMissingKey: 'off' } },
    );
    await expect(off.findAll({ status: 'active' })).resolves.toHaveLength(2);

    const plain = new Repository<IDoc>(Model);
    await expect(plain.findAll({ status: 'active' })).resolves.toHaveLength(2);
  });
});
