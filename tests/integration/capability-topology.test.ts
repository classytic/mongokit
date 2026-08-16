/**
 * THE FALSIFICATION. A standalone `mongod` and a replica set must produce
 * DIFFERENT capability answers — and the answers must match what the server
 * actually does when a transaction is attempted.
 *
 * Before 2026-08-05 this test could not have failed: `Repository#capabilities`
 * was the static `MONGOKIT_CAPABILITIES`, so `transactions` read `true` on a
 * standalone that rejects `session.startTransaction()` outright. Every kernel
 * boot gate downstream (wallet, party, invoice, purchase, flow) inherited that
 * lie and was therefore unfalsifiable decoration — AGENTS.md FAIL LOUD rule 4.
 *
 * This file deliberately boots its OWN servers instead of the shared
 * `globalSetup` replica set: the whole point is comparing two topologies, and
 * `MONGODB_URI` only ever names one of them.
 */
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Connection, Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isTransactionUnsupported,
  probeMongoCapabilities,
  Repository,
  resetCapabilityProbeCache,
  resolveTransactionSupport,
  supportsTransactions,
  transactionResolutionOf,
  withTransaction,
} from '../../src/index.js';

interface Widget {
  name: string;
}

const widgetSchema = new Schema<Widget>({ name: String });

let standalone: MongoMemoryServer;
let replset: MongoMemoryReplSet;
let standaloneConn: Connection;
let replsetConn: Connection;

function repoOn(connection: Connection): Repository<Widget> {
  const Model = connection.model<Widget>('CapWidget', widgetSchema);
  return new Repository<Widget>(Model);
}

beforeAll(async () => {
  standalone = await MongoMemoryServer.create();
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  standaloneConn = await mongoose.createConnection(standalone.getUri('cap-standalone')).asPromise();
  replsetConn = await mongoose.createConnection(replset.getUri('cap-replset')).asPromise();
}, 120_000);

afterAll(async () => {
  await standaloneConn?.close().catch(() => undefined);
  await replsetConn?.close().catch(() => undefined);
  await standalone?.stop().catch(() => undefined);
  await replset?.stop().catch(() => undefined);
});

describe('standalone mongod', () => {
  it('the deployment genuinely CANNOT run a transaction (the ground truth)', async () => {
    let failure: Error | undefined;
    // The body must actually WRITE — an empty transaction never reaches the
    // server, so it "commits" even on a standalone and proves nothing.
    await withTransaction(standaloneConn, async (session) => {
      await standaloneConn.db?.collection('txn-probe').insertOne({ n: 1 }, { session });
    }).catch((e: Error) => {
      failure = e;
    });
    expect(failure).toBeDefined();
    expect(isTransactionUnsupported(failure as Error)).toBe(true);
  });

  it('and the capability descriptor SAYS SO — observed false, not declared true', () => {
    const caps = repoOn(standaloneConn).capabilities;
    expect(caps.transactions).toBe(false);
    expect(caps.nestedTransactions).toBe(false);
    // Change streams need the same oplog.
    expect(caps.changeStreams).toBe(false);
    expect(transactionResolutionOf(caps)).toBe('observed');
  });

  it('flags that do NOT depend on the deployment are unchanged', () => {
    const caps = repoOn(standaloneConn).capabilities;
    expect(caps.upsert).toBe(true);
    expect(caps.duplicateKeyError).toBe(true);
    expect(caps.getOrCreate).toBe(true);
    expect(caps.aggregate).toBe(true);
    expect(caps.aggregateOps?.percentile).toBe(true);
  });

  it('resolveTransactionSupport / supportsTransactions agree', () => {
    expect(resolveTransactionSupport(standaloneConn)).toBe('no');
    expect(supportsTransactions(standaloneConn)).toBe(false);
  });

  it('the async probe reaches the same verdict', async () => {
    resetCapabilityProbeCache(standaloneConn);
    const caps = await probeMongoCapabilities(standaloneConn, { timeoutMs: 5000 });
    expect(caps.transactions).toBe(false);
    expect(transactionResolutionOf(caps)).toBe('observed');
  });
});

describe('replica set', () => {
  it('the deployment genuinely CAN run a transaction (the ground truth)', async () => {
    const committed = await withTransaction(replsetConn, async () => 'ok');
    expect(committed).toBe('ok');
  });

  it('and the capability descriptor says so — observed true', () => {
    const caps = repoOn(replsetConn).capabilities;
    expect(caps.transactions).toBe(true);
    expect(caps.changeStreams).toBe(true);
    expect(transactionResolutionOf(caps)).toBe('observed');
  });

  it('nestedTransactions is FALSE even here — and the tx-bound repo proves it', async () => {
    // The descriptor used to say `true` on a replica set (reasoning about the
    // DRIVER, which does allow nesting on one session) while mongokit's own
    // tx-bound proxy threw on the very same call. A capability is a promise
    // to a caller who cannot see the implementation, so it must describe THIS
    // repository. Ground truth first, declaration second.
    const repo = repoOn(replsetConn);
    expect(repo.capabilities.nestedTransactions).toBe(false);

    await expect(
      repo.withTransaction(async (txRepo) => {
        await txRepo.withTransaction(async () => 'nested');
      }),
    ).rejects.toThrow(/Nested withTransaction is not supported/);
  });

  it("declares itself the retry authority — the driver already re-runs the callback", () => {
    // `session.withTransaction()` retries TransientTransactionError /
    // UnknownTransactionCommitResult internally for up to 120s. An outer
    // envelope must therefore call it exactly ONCE; repo-core's
    // `retryingTransaction` reads this to decide.
    expect(repoOn(replsetConn).capabilities.transactionRetry).toBe('managed');
  });

  it('resolveTransactionSupport / supportsTransactions agree', () => {
    expect(resolveTransactionSupport(replsetConn)).toBe('yes');
    expect(supportsTransactions(replsetConn)).toBe(true);
  });

  it('the async probe reaches the same verdict', async () => {
    resetCapabilityProbeCache(replsetConn);
    const caps = await probeMongoCapabilities(replsetConn, { timeoutMs: 5000 });
    expect(caps.transactions).toBe(true);
  });
});

describe('the two topologies DISAGREE — which is the whole point', () => {
  it('same mongokit, same Repository class, opposite answers', () => {
    expect(repoOn(standaloneConn).capabilities.transactions).toBe(false);
    expect(repoOn(replsetConn).capabilities.transactions).toBe(true);
  });
});

describe('descriptor plumbing', () => {
  it('capabilities is LIVE — a repo built before connect upgrades itself once the topology is up', async () => {
    const late = mongoose.createConnection();
    const repo = new Repository<Widget>(late.model<Widget>('LateWidget', widgetSchema));
    // No client at all yet: the answer must not be an optimistic yes.
    expect(repo.capabilities.transactions).toBe(false);
    expect(transactionResolutionOf(repo.capabilities)).toBe('unknown');

    await late.openUri(replset.getUri('cap-late'));

    // Same repository instance, no re-construction, no invalidation call.
    expect(repo.capabilities.transactions).toBe(true);
    expect(transactionResolutionOf(repo.capabilities)).toBe('observed');
    await late.close();
  });

  it('a URI that DECLARES a replica set is a yes even mid-election (documented, not accidental)', async () => {
    // `?replicaSet=…` makes the driver's initial TopologyDescription
    // `ReplicaSetNoPrimary` before any server is discovered. That is still a
    // positive statement about the DEPLOYMENT, so we accept it — otherwise a
    // boot that lands during a primary election would fail a money kernel on a
    // perfectly transactional cluster. The standalone case has no such
    // declaration and stays a hard `no`.
    const uri = replset.getUri('cap-declared');
    expect(uri).toContain('replicaSet=');
    const conn = mongoose.createConnection(uri);
    expect(resolveTransactionSupport(conn)).toBe('yes');
    await conn.asPromise();
    await conn.close();
  });

  it('an explicit options.capabilities override wins (the documented escape hatch)', () => {
    const Model = standaloneConn.model<Widget>('OverrideWidget', widgetSchema);
    const repo = new Repository<Widget>(Model, [], {}, {
      capabilities: { ...repoOn(replsetConn).capabilities },
    });
    expect(repo.capabilities.transactions).toBe(true);
  });

  it('the probe is memoized per connection — N repos issue at most one hello', async () => {
    resetCapabilityProbeCache(replsetConn);
    const [a, b, c] = await Promise.all([
      probeMongoCapabilities(replsetConn),
      probeMongoCapabilities(replsetConn),
      probeMongoCapabilities(replsetConn),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
