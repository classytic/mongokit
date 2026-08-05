/**
 * Capability descriptor — the PURE half (no mongod).
 *
 * The falsification that matters (a real standalone vs a real replica set
 * producing DIFFERENT answers) lives in
 * `tests/integration/capability-topology.test.ts`. This file pins the
 * classification rules and, above all, the `unknown` policy: an answer we did
 * not observe must never be reported as a yes (AGENTS.md FAIL LOUD rule 3).
 */
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  capabilitiesForSupport,
  classifyHelloReply,
  MONGOKIT_CAPABILITIES,
  probeMongoCapabilities,
  resolveMongoCapabilities,
  resolveTransactionSupport,
  supportsTransactions,
  transactionResolutionOf,
} from '../../src/index.js';

/** Minimal fake of the driver's SDAM topology description. */
function fakeConnection(topologyType: string | undefined, serverTypes: string[] = []) {
  return {
    readyState: 1,
    getClient: () => ({
      topology: {
        description: {
          type: topologyType,
          servers: new Map(serverTypes.map((t, i) => [`h${i}:27017`, { type: t }])),
        },
      },
    }),
  };
}

describe('resolveTransactionSupport — server type decides', () => {
  it('a standalone mongod is a positive NO', () => {
    expect(resolveTransactionSupport(fakeConnection('Single', ['Standalone']))).toBe('no');
  });

  it('a replica set primary is a YES', () => {
    expect(resolveTransactionSupport(fakeConnection('ReplicaSetWithPrimary', ['RSPrimary']))).toBe('yes');
  });

  it('a DIRECTLY connected single-node replica set is a YES (topology type alone would say Single)', () => {
    // The pre-2026-08 heuristic was `description.type !== 'Single'`, which
    // called this deployment untransactable. It is not — it runs transactions.
    expect(resolveTransactionSupport(fakeConnection('Single', ['RSPrimary']))).toBe('yes');
  });

  it('a mongos is a YES', () => {
    expect(resolveTransactionSupport(fakeConnection('Sharded', ['Mongos']))).toBe('yes');
  });

  it('an unresolved topology is UNKNOWN, not a yes', () => {
    expect(resolveTransactionSupport(fakeConnection('Unknown', ['Unknown']))).toBe('unknown');
    expect(resolveTransactionSupport(fakeConnection('Single', []))).toBe('unknown');
    expect(resolveTransactionSupport(fakeConnection(undefined, []))).toBe('unknown');
  });

  it('no connection, no client, a throwing getClient — all UNKNOWN', () => {
    expect(resolveTransactionSupport(undefined)).toBe('unknown');
    expect(resolveTransactionSupport(null)).toBe('unknown');
    expect(resolveTransactionSupport({})).toBe('unknown');
    expect(
      resolveTransactionSupport({
        getClient: () => {
          throw new Error('not connected');
        },
      }),
    ).toBe('unknown');
  });

  it('an UNCONNECTED mongoose connection is UNKNOWN', () => {
    expect(resolveTransactionSupport(mongoose.createConnection())).toBe('unknown');
  });
});

describe('unknown fails CLOSED', () => {
  it('reports transactions:false so a `!== true` gate refuses it', () => {
    const caps = resolveMongoCapabilities(mongoose.createConnection());
    expect(caps.transactions).toBe(false);
    expect(caps.nestedTransactions).toBe(false);
    expect(caps.changeStreams).toBe(false);
    expect(transactionResolutionOf(caps)).toBe('unknown');
  });

  it('is DISTINGUISHABLE from an observed no, so a gate can say something actionable', () => {
    expect(transactionResolutionOf(capabilitiesForSupport('unknown'))).toBe('unknown');
    expect(transactionResolutionOf(capabilitiesForSupport('no'))).toBe('observed');
    expect(capabilitiesForSupport('unknown').transactions).toBe(false);
    expect(capabilitiesForSupport('no').transactions).toBe(false);
  });

  it('a probe against a never-opened connection resolves UNKNOWN promptly — it must not hang', async () => {
    const started = Date.now();
    const caps = await probeMongoCapabilities(mongoose.createConnection(), { timeoutMs: 500 });
    expect(caps.transactions).toBe(false);
    expect(transactionResolutionOf(caps)).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('a probe against a non-object is UNKNOWN, not a crash and not a yes', async () => {
    expect((await probeMongoCapabilities(undefined)).transactions).toBe(false);
    expect(transactionResolutionOf(await probeMongoCapabilities('nope'))).toBe('unknown');
  });
});

describe('classifyHelloReply', () => {
  it('setName ⇒ replica-set member ⇒ yes', () => {
    expect(classifyHelloReply({ setName: 'rs0', isWritablePrimary: true })).toBe('yes');
  });

  it("msg 'isdbgrid' ⇒ mongos ⇒ yes", () => {
    expect(classifyHelloReply({ msg: 'isdbgrid' })).toBe('yes');
  });

  it('a hello with neither marker ⇒ standalone ⇒ no', () => {
    // Verified shape from a real mongodb-memory-server standalone.
    expect(classifyHelloReply({ isWritablePrimary: true })).toBe('no');
    expect(classifyHelloReply({ ismaster: true })).toBe('no');
  });

  it('an unparseable reply ⇒ unknown, never yes', () => {
    expect(classifyHelloReply(undefined)).toBe('unknown');
    expect(classifyHelloReply({})).toBe('unknown');
    expect(classifyHelloReply({ setName: '' })).toBe('unknown');
  });
});

describe('the declared baseline stays declared', () => {
  it('MONGOKIT_CAPABILITIES describes the PRODUCT and says so', () => {
    // Static kits (sqlitekit / prismakit) legitimately declare; the field is
    // how a gate tells a declaration from an observation.
    expect(MONGOKIT_CAPABILITIES.transactions).toBe(true);
    expect(transactionResolutionOf(MONGOKIT_CAPABILITIES)).toBe('declared');
  });

  it('a descriptor with no resolution field reads as declared (non-mongo kits unaffected)', () => {
    expect(transactionResolutionOf({ transactions: true } as never)).toBe('declared');
  });
});

describe('supportsTransactions keeps its OPTIMISTIC unknown (deliberate asymmetry)', () => {
  it('false only for a positively observed standalone', () => {
    expect(supportsTransactions(fakeConnection('Single', ['Standalone']))).toBe(false);
  });

  it('true for a replica set, and true for an unknown — a doomed attempt is still caught reactively', () => {
    expect(supportsTransactions(fakeConnection('ReplicaSetWithPrimary', ['RSPrimary']))).toBe(true);
    expect(supportsTransactions(mongoose.createConnection())).toBe(true);
    expect(supportsTransactions(undefined)).toBe(true);
  });
});
