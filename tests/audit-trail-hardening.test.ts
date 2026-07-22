/**
 * Audit Trail Hardening Tests (3.25)
 *
 * Pins the four production-readiness fixes:
 *  1. `mode: 'transactional'` — awaited, session-joined writes: atomic with
 *     the business write inside withTransaction, operation fails when the
 *     audit insert fails, apply-time rejection on hooks:'sync' repos.
 *  2. Connection-aware model registry — audit entries land on the connection
 *     the plugin was given, never leak to the global connection's DB.
 *  3. Deterministic TTL — conflicting ttlDays for the same collection on the
 *     same connection throws instead of silently keeping the first caller's.
 *  4. Snapshot semantics — the before-update snapshot honors the repo's
 *     configured idField (so `idField: 'slug'` repos still produce diffs)
 *     and joins the operation's transaction session.
 */

import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditTrailQuery,
  auditTrailPlugin,
  ensureAuditTrailReady,
  Repository,
} from '../src/index.js';

interface IAuditedDoc {
  _id: Types.ObjectId;
  slug: string;
  name: string;
  price: number;
}

const AuditedDocSchema = new Schema<IAuditedDoc>({
  slug: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
});

function makeModel(name: string): mongoose.Model<IAuditedDoc> {
  if (mongoose.models[name]) delete mongoose.models[name];
  return mongoose.model<IAuditedDoc>(name, AuditedDocSchema);
}

describe('auditTrailPlugin hardening', () => {
  let replset: MongoMemoryReplSet;

  beforeAll(async () => {
    await mongoose.disconnect();
    replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replset.getUri('mongokit-audit-hardening'));
  }, 60000);

  afterAll(async () => {
    await mongoose.disconnect();
    await replset.stop();
  }, 60000);

  // ─── 1. Transactional mode ────────────────────────────────────────────────

  describe("mode: 'transactional'", () => {
    const COLLECTION = 'audit_tx_mode';
    let Model: mongoose.Model<IAuditedDoc>;
    let repo: Repository<IAuditedDoc>;

    beforeAll(async () => {
      Model = makeModel('AuditTxModeDoc');
      await Model.init();
      repo = new Repository(Model, [
        auditTrailPlugin({ mode: 'transactional', collectionName: COLLECTION }),
      ]);
      // Documented production setup: pre-create the collection + indexes so
      // the first transactional insert doesn't trigger catalog-lock retries
      // (the exact noise ensureAuditTrailReady exists to prevent).
      await ensureAuditTrailReady({ collectionName: COLLECTION });
    });

    beforeEach(async () => {
      await Model.deleteMany({});
      await mongoose.connection
        .collection(COLLECTION)
        .deleteMany({})
        .catch(() => {});
    });

    it('audit entry is visible immediately after the operation (no waitForAudit)', async () => {
      await repo.create({ slug: 'w1', name: 'Widget', price: 10 });

      // No sleep — transactional writes are awaited inside the op.
      const audits = await mongoose.connection.collection(COLLECTION).find({}).toArray();
      expect(audits).toHaveLength(1);
      expect(audits[0].operation).toBe('create');
    });

    it('rolls back the audit entry when the surrounding transaction aborts', async () => {
      await expect(
        repo.withTransaction(async (txRepo) => {
          await txRepo.create({ slug: 'doomed', name: 'Doomed', price: 1 });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(await Model.countDocuments({})).toBe(0);
      const audits = await mongoose.connection.collection(COLLECTION).find({}).toArray();
      expect(audits).toHaveLength(0); // ← the fix: no orphan audit for an aborted tx
    });

    it('commits business write + audit entry atomically on success', async () => {
      await repo.withTransaction(async (txRepo) => {
        await txRepo.create({ slug: 'kept', name: 'Kept', price: 2 });
      });

      expect(await Model.countDocuments({})).toBe(1);
      const audits = await mongoose.connection.collection(COLLECTION).find({}).toArray();
      expect(audits).toHaveLength(1);
    });

    it('fails the operation when the audit write fails (and fires onWriteError first)', async () => {
      const onWriteError = vi.fn();
      const failRepo = new Repository(Model, [
        auditTrailPlugin({
          mode: 'transactional',
          collectionName: COLLECTION,
          onWriteError,
        }),
      ]);

      const auditModel = new AuditTrailQuery({ collectionName: COLLECTION }).getModel();
      const spy = vi.spyOn(auditModel, 'create').mockRejectedValueOnce(new Error('audit down'));

      try {
        await expect(failRepo.create({ slug: 'nofail', name: 'X', price: 3 })).rejects.toThrow(
          'audit down',
        );
        expect(onWriteError).toHaveBeenCalledTimes(1);
        expect(onWriteError.mock.calls[0][0]).toBeInstanceOf(Error);
      } finally {
        spy.mockRestore();
      }
    });

    it("throws at plugin apply time on a hooks:'sync' repository", () => {
      expect(
        () =>
          new Repository(
            Model,
            [auditTrailPlugin({ mode: 'transactional' })],
            {},
            { hooks: 'sync' },
          ),
      ).toThrow(/transactional.*hooks: 'async'/s);
    });
  });

  // ─── 2. Connection-aware model registry ──────────────────────────────────

  describe('connection option', () => {
    it('writes audit entries to the passed connection, not the global one', async () => {
      const otherConn = mongoose.createConnection(replset.getUri('mongokit-audit-other-db'));
      await otherConn.asPromise();

      try {
        const OtherModel = otherConn.model<IAuditedDoc>('AuditOtherConnDoc', AuditedDocSchema);
        await OtherModel.init();

        const COLLECTION = 'audit_conn_aware';
        const repo = new Repository(OtherModel, [
          auditTrailPlugin({
            mode: 'transactional',
            connection: otherConn,
            collectionName: COLLECTION,
          }),
        ]);

        await repo.create({ slug: 'conn1', name: 'ConnDoc', price: 5 });

        // Entry lands in the named connection's database…
        const there = await otherConn.collection(COLLECTION).find({}).toArray();
        expect(there).toHaveLength(1);

        // …and NOT in the default connection's database.
        const here = await mongoose.connection.collection(COLLECTION).find({}).toArray();
        expect(here).toHaveLength(0);
      } finally {
        await otherConn.close();
      }
    });

    it("defaults to the model's OWN connection when `connection` is omitted", async () => {
      // Finding-5 DX: a createConnection() app that forgets to pass
      // `connection` should still get audit entries in the model's database,
      // NOT the global one. The plugin infers `repo.Model.db`.
      const otherConn = mongoose.createConnection(replset.getUri('mongokit-audit-infer-db'));
      await otherConn.asPromise();

      try {
        const OtherModel = otherConn.model<IAuditedDoc>('AuditInferConnDoc', AuditedDocSchema);
        await OtherModel.init();

        const COLLECTION = 'audit_conn_inferred';
        // NOTE: no `connection` option — inferred from the model.
        const repo = new Repository(OtherModel, [
          auditTrailPlugin({ mode: 'transactional', collectionName: COLLECTION }),
        ]);
        await repo.create({ slug: 'infer1', name: 'InferDoc', price: 9 });

        const there = await otherConn.collection(COLLECTION).find({}).toArray();
        expect(there).toHaveLength(1);
        const here = await mongoose.connection.collection(COLLECTION).find({}).toArray();
        expect(here).toHaveLength(0);
      } finally {
        await otherConn.close();
      }
    });

    it('AuditTrailQuery targets the same named connection', async () => {
      const otherConn = mongoose.createConnection(replset.getUri('mongokit-audit-query-db'));
      await otherConn.asPromise();

      try {
        const OtherModel = otherConn.model<IAuditedDoc>('AuditQueryConnDoc', AuditedDocSchema);
        await OtherModel.init();

        const COLLECTION = 'audit_conn_query';
        const repo = new Repository(OtherModel, [
          auditTrailPlugin({
            mode: 'transactional',
            connection: otherConn,
            collectionName: COLLECTION,
          }),
        ]);
        await repo.create({ slug: 'q1', name: 'QueryDoc', price: 7 });

        const auditQuery = new AuditTrailQuery({
          connection: otherConn,
          collectionName: COLLECTION,
        });
        const result = await auditQuery.query({});
        expect(result.total).toBe(1);
        expect(result.data[0].operation).toBe('create');
      } finally {
        await otherConn.close();
      }
    });
  });

  // ─── 3. Deterministic TTL ────────────────────────────────────────────────

  describe('TTL determinism', () => {
    it('throws when a second plugin requests a different ttlDays for the same collection', async () => {
      const Model = makeModel('AuditTtlConflictDoc');
      await Model.init();
      const COLLECTION = 'audit_ttl_conflict';

      // First registration wins the config…
      void new Repository(Model, [auditTrailPlugin({ collectionName: COLLECTION, ttlDays: 30 })]);

      // …a conflicting second registration must throw, not silently reuse 30d.
      expect(
        () =>
          new Repository(Model, [auditTrailPlugin({ collectionName: COLLECTION, ttlDays: 365 })]),
      ).toThrow(/TTL conflict/);

      // no-TTL vs TTL is also a conflict.
      expect(
        () => new Repository(Model, [auditTrailPlugin({ collectionName: COLLECTION })]),
      ).toThrow(/TTL conflict/);

      // Same value is fine.
      expect(
        () =>
          new Repository(Model, [auditTrailPlugin({ collectionName: COLLECTION, ttlDays: 30 })]),
      ).not.toThrow();
    });

    it('AuditTrailQuery: explicit conflicting ttlDays throws; omitted reuses', () => {
      const COLLECTION = 'audit_ttl_query_conflict';
      void new AuditTrailQuery({ collectionName: COLLECTION, ttlDays: 7 });

      // An explicit disagreeing value is still a conflict…
      expect(() => new AuditTrailQuery({ collectionName: COLLECTION, ttlDays: 14 })).toThrow(
        /TTL conflict/,
      );
      expect(() => new AuditTrailQuery({ collectionName: COLLECTION, ttlDays: 7 })).not.toThrow();
      // …but readers omitting ttlDays reuse whatever retention is configured —
      // querying audit history must not require knowing it.
      expect(() => new AuditTrailQuery({ collectionName: COLLECTION })).not.toThrow();
    });
  });

  // ─── 3.5 Boot readiness ──────────────────────────────────────────────────

  describe('ensureAuditTrailReady', () => {
    it('creates the collection + indexes before first use, idempotently', async () => {
      const COLLECTION = 'audit_boot_ready';
      const Model = makeModel('AuditBootReadyDoc');
      await Model.init();
      void new Repository(Model, [
        auditTrailPlugin({ mode: 'transactional', collectionName: COLLECTION, ttlDays: 30 }),
      ]);

      // Omitted ttlDays — reuses the plugin's registration.
      await ensureAuditTrailReady({ collectionName: COLLECTION });

      const collections = await mongoose.connection.db
        ?.listCollections({ name: COLLECTION })
        .toArray();
      expect(collections).toHaveLength(1);

      const indexes = await mongoose.connection.collection(COLLECTION).indexes();
      const ttlIndex = indexes.find((ix) => ix.expireAfterSeconds !== undefined);
      expect(ttlIndex).toBeDefined();
      expect(ttlIndex?.expireAfterSeconds).toBe(30 * 24 * 60 * 60);

      // Second call is a no-op, not an error.
      await expect(ensureAuditTrailReady({ collectionName: COLLECTION })).resolves.toBeUndefined();
    });
  });

  // ─── 4. Snapshot semantics (idField + session) ───────────────────────────

  describe('before-update snapshot', () => {
    it("produces a changes diff for repos with idField: 'slug'", async () => {
      const Model = makeModel('AuditSlugIdDoc');
      await Model.init();
      const COLLECTION = 'audit_slug_idfield';
      const repo = new Repository(
        Model,
        [auditTrailPlugin({ mode: 'transactional', collectionName: COLLECTION })],
        {},
        { idField: 'slug' },
      );

      await Model.deleteMany({});
      await mongoose.connection
        .collection(COLLECTION)
        .deleteMany({})
        .catch(() => {});

      await repo.create({ slug: 'sluggy', name: 'Before', price: 10 });
      await repo.update('sluggy', { name: 'After' });

      const audits = await mongoose.connection
        .collection(COLLECTION)
        .find({ operation: 'update' })
        .toArray();
      expect(audits).toHaveLength(1);
      // Pre-fix, the snapshot ran Model.findById('sluggy') → no match → no diff.
      expect(audits[0].changes).toBeDefined();
      expect(audits[0].changes.name).toEqual({ from: 'Before', to: 'After' });
    });

    it('reads the snapshot through the transaction session (sees in-tx state)', async () => {
      const Model = makeModel('AuditTxSnapshotDoc');
      await Model.init();
      const COLLECTION = 'audit_tx_snapshot';
      const repo = new Repository(Model, [
        auditTrailPlugin({ mode: 'transactional', collectionName: COLLECTION }),
      ]);

      await ensureAuditTrailReady({ collectionName: COLLECTION });
      await Model.deleteMany({});
      await mongoose.connection
        .collection(COLLECTION)
        .deleteMany({})
        .catch(() => {});

      // Create + update inside ONE transaction. The pre-update snapshot must
      // see the in-transaction document (price 1) — a session-less read would
      // find nothing (doc not committed yet) and produce no diff.
      await repo.withTransaction(async (txRepo) => {
        const doc = await txRepo.create({ slug: 'tx-snap', name: 'TxDoc', price: 1 });
        await txRepo.update(String(doc._id), { price: 2 });
      });

      const audits = await mongoose.connection
        .collection(COLLECTION)
        .find({ operation: 'update' })
        .toArray();
      expect(audits).toHaveLength(1);
      expect(audits[0].changes).toBeDefined();
      expect(audits[0].changes.price).toEqual({ from: 1, to: 2 });
    });
  });
});
