/**
 * Abandoned mongodb-memory-server data dirs are removed; live ones never are.
 *
 * A run that is killed, crashes or times out never reaches `stop()`, so its
 * `mongo-mem-*` dir stays in the temp dir for good (one machine: 3,698 dirs,
 * ~57 GB). The sweep removes a dir only when its `mongod.lock` names no live
 * process AND nothing in it changed for the configured age.
 *
 * The dead pid is a real one: a child that has already exited. The live pid is
 * this process, and in the real-mongod cases a running mongod's own lock.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMongoMemory } from '../../src/testkit/index.js';
import {
  isPidAlive,
  launchMongoMemory,
  mongoMemoryTmpBase,
  staleMongoMemoryAgeMs,
  sweepStaleMongoMemoryDirs,
} from '../../src/testkit/mongo-tmp.js';

const HOUR = 3_600_000;
let base: string;

/** A pid that existed and is gone: a child that ran and exited. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  expect(isPidAlive(pid)).toBe(false);
  return pid;
}

/**
 * A fake data dir whose `mongod.lock` names `pid` ("" = emptied by a clean
 * shutdown, null = no lock), everything in it last touched `ageMs` ago.
 */
function fakeDataDir(name: string, pid: number | '' | null, ageMs: number): string {
  const dir = join(base, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'WiredTiger.wt'), 'x');
  if (pid !== null) writeFileSync(join(dir, 'mongod.lock'), String(pid));
  const t = new Date(Date.now() - ageMs);
  for (const f of readdirSync(dir)) utimesSync(join(dir, f), t, t);
  utimesSync(dir, t, t);
  return dir;
}

const savedEnv = { ...process.env };
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mongokit-mongo-tmp-test-'));
});
afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(base, { recursive: true, force: true });
});

describe('sweepStaleMongoMemoryDirs', () => {
  it('removes an abandoned dir and keeps live, recent and foreign ones', async () => {
    const dead = deadPid();
    const abandoned = fakeDataDir('mongo-mem-abandoned', dead, 7 * HOUR);
    const cleanShutdown = fakeDataDir('mongo-mem-clean', '', 7 * HOUR);
    const neverStarted = fakeDataDir('mongo-mem-nolock', null, 7 * HOUR);
    const live = fakeDataDir('mongo-mem-live', process.pid, 7 * HOUR);
    const recent = fakeDataDir('mongo-mem-recent', dead, 1 * HOUR);
    const keyfile = fakeDataDir('mongo-mem-keyfile-abc', dead, 7 * HOUR);
    const foreign = fakeDataDir('not-mongo-abc', dead, 7 * HOUR);

    const result = await sweepStaleMongoMemoryDirs({ dirs: [base] });

    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(cleanShutdown)).toBe(false);
    expect(existsSync(neverStarted)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(keyfile)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(result.removed.sort()).toEqual([abandoned, cleanShutdown, neverStarted].sort());
    expect(result.kept).toEqual(
      expect.arrayContaining([
        { path: live, reason: 'live-process' },
        { path: recent, reason: 'recent' },
      ]),
    );
    expect(result.failed).toEqual([]);
  });

  it("judges age by the newest file, not the dir's own mtime", async () => {
    const dir = fakeDataDir('mongo-mem-busy', deadPid(), 7 * HOUR);
    const now = new Date();
    utimesSync(join(dir, 'WiredTiger.wt'), now, now); // a checkpoint just wrote it

    await sweepStaleMongoMemoryDirs({ dirs: [base] });

    expect(existsSync(dir)).toBe(true);
  });

  it('reads the age from TEST_MONGO_SWEEP_HOURS, and `off` disables it', async () => {
    const dir = fakeDataDir('mongo-mem-two-hours', deadPid(), 2 * HOUR);

    process.env.TEST_MONGO_SWEEP_HOURS = 'off';
    expect(staleMongoMemoryAgeMs()).toBeNull();
    await sweepStaleMongoMemoryDirs({ dirs: [base] });
    expect(existsSync(dir)).toBe(true);

    delete process.env.TEST_MONGO_SWEEP_HOURS;
    expect(staleMongoMemoryAgeMs()).toBe(6 * HOUR);
    await sweepStaleMongoMemoryDirs({ dirs: [base] });
    expect(existsSync(dir)).toBe(true);

    process.env.TEST_MONGO_SWEEP_HOURS = '1';
    await sweepStaleMongoMemoryDirs({ dirs: [base] });
    expect(existsSync(dir)).toBe(false);
  });

  it('scans TEST_MONGO_TMPDIR by default', async () => {
    // Point os.tmpdir() at an empty dir: the default also scans the real temp
    // dir, which is not this test's to sweep (and can hold thousands of dirs).
    const emptyTmp = join(base, 'empty-tmp');
    mkdirSync(emptyTmp);
    process.env.TMPDIR = emptyTmp;
    process.env.TMP = emptyTmp;
    process.env.TEMP = emptyTmp;
    process.env.TEST_MONGO_TMPDIR = base;
    expect(mongoMemoryTmpBase()).toBe(base);
    const dir = fakeDataDir('mongo-mem-in-base', deadPid(), 7 * HOUR);

    const result = await sweepStaleMongoMemoryDirs();

    expect(result.removed).toContain(dir);
  });
});

/** `mongo-mem-*` dirs currently in the base. */
const dataDirs = () => readdirSync(base).filter((n) => n.startsWith('mongo-mem-'));

describe('launchMongoMemory on a real mongod', () => {
  it('puts the data dir under TEST_MONGO_TMPDIR, keeps it while live, removes it on stop', async () => {
    process.env.TEST_MONGO_TMPDIR = base;
    const launched = await launchMongoMemory(MongoMemoryServer, 'standalone');
    expect(dataDirs()).toHaveLength(1);

    // Age 0: only the live-process check protects it, and it must.
    const sweep = await sweepStaleMongoMemoryDirs({ dirs: [base], maxAgeMs: 0 });
    expect(sweep.removed).toEqual([]);
    expect(sweep.kept.map((k) => k.reason)).toEqual(['live-process']);

    await launched.stop();
    expect(dataDirs()).toEqual([]);
  }, 120_000);

  it('stopSync kills mongod and removes the dir without awaiting anything', async () => {
    process.env.TEST_MONGO_TMPDIR = base;
    const launched = await launchMongoMemory(MongoMemoryServer, 'standalone');
    const pid = launched.server.instanceInfo?.instance.mongodProcess?.pid as number;
    expect(isPidAlive(pid)).toBe(true);

    launched.stopSync();

    expect(dataDirs()).toEqual([]);
    await expect.poll(() => isPidAlive(pid), { timeout: 10_000 }).toBe(false);
  }, 120_000);

  it('removes the data dir of a server that failed to start', async () => {
    process.env.TEST_MONGO_TMPDIR = base;
    await expect(
      launchMongoMemory(MongoMemoryServer, 'standalone', {
        instance: { args: ['--notARealMongodFlag'] },
      }),
    ).rejects.toThrow();
    expect(dataDirs()).toEqual([]);
  }, 120_000);

  it('gives every replica-set member a dir under the base and removes them on stop', async () => {
    process.env.TEST_MONGO_TMPDIR = base;
    const launched = await launchMongoMemory(MongoMemoryReplSet, 'replset', {
      replSet: { count: 1 },
    });
    expect(dataDirs()).toHaveLength(1);
    expect(launched.server.getUri()).toMatch(/replicaSet=/);

    await launched.stop();
    expect(dataDirs()).toEqual([]);
  }, 120_000);
});

describe('createMongoMemory', () => {
  it('starts through the launcher: data dir under TEST_MONGO_TMPDIR, removed on stop', async () => {
    process.env.TEST_MONGO_TMPDIR = base;
    const saved = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI; // the shared server's URI would short-circuit to "external"
    try {
      const handle = await createMongoMemory();
      expect(handle.server).toBeDefined();
      expect(dataDirs()).toHaveLength(1);
      await handle.stop();
      expect(dataDirs()).toEqual([]);
      await handle.stop(); // idempotent
    } finally {
      if (saved !== undefined) process.env.MONGODB_URI = saved;
    }
  }, 120_000);
});

// ── Shutdown that fails (review P2) ────────────────────────────────────────
// A stop whose cleanup fails must leave the server stoppable: a retry runs the
// stop again, and the synchronous exit fallback still kills mongod.

/** Make `server.stop` fail once, as a cleanup that hits EBUSY would. */
function failStopOnce(server: { stop: (...args: never[]) => Promise<unknown> }): void {
  const real = server.stop.bind(server);
  let fail = true;
  server.stop = (async (...args: never[]) => {
    if (fail) {
      fail = false;
      throw new Error('simulated cleanup failure (EBUSY)');
    }
    return real(...args);
  }) as typeof server.stop;
}

describe('a failed stop stays retryable', () => {
  it('launchMongoMemory: a retried stop() stops mongod and removes the dir', async () => {
    process.env.TEST_MONGO_TMPDIR = base;
    const launched = await launchMongoMemory(MongoMemoryServer, 'standalone');
    const pid = launched.server.instanceInfo?.instance.mongodProcess?.pid as number;
    failStopOnce(launched.server as never);
    await expect(launched.stop()).rejects.toThrow(/simulated/);
    expect(isPidAlive(pid)).toBe(true);
    await launched.stop();
    await expect.poll(() => isPidAlive(pid), { timeout: 10_000 }).toBe(false);
    expect(dataDirs()).toEqual([]);
  }, 120_000);

  it('launchMongoMemory: after a failed stop(), stopSync() still kills mongod', async () => {
    process.env.TEST_MONGO_TMPDIR = base;
    const launched = await launchMongoMemory(MongoMemoryServer, 'standalone');
    const pid = launched.server.instanceInfo?.instance.mongodProcess?.pid as number;
    failStopOnce(launched.server as never);
    await launched.stop().catch(() => undefined);
    launched.stopSync();
    await expect.poll(() => isPidAlive(pid), { timeout: 10_000 }).toBe(false);
    expect(dataDirs()).toEqual([]);
  }, 120_000);

  it('createMongoMemory: a retried handle.stop() stops the server', async () => {
    process.env.TEST_MONGO_TMPDIR = base;
    const saved = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    try {
      const handle = await createMongoMemory();
      const server = handle.server as MongoMemoryServer;
      const pid = server.instanceInfo?.instance.mongodProcess?.pid as number;
      failStopOnce(server as never);
      await handle.stop().catch(() => undefined);
      expect(isPidAlive(pid)).toBe(true);
      await handle.stop();
      await expect.poll(() => isPidAlive(pid), { timeout: 10_000 }).toBe(false);
      expect(dataDirs()).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.MONGODB_URI = saved;
    }
  }, 120_000);
});
