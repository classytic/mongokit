/**
 * mongodb-memory-server temp-dir hygiene: start, stop and sweep so that a test
 * run that is killed, crashes or times out does not leave its data dir behind.
 *
 * ## Why this exists
 *
 * mongodb-memory-server creates `mongo-mem-XXXXXX` under `os.tmpdir()` for every
 * server and removes it in `stop()` (`doCleanup: true` is the default since v9).
 * That only covers the orderly path. A run killed from an IDE, a CI cancel, a
 * worker terminated on timeout or a hard crash never reaches `stop()`, and the
 * dir (a full WiredTiger data set, ~15 MB at minimum) stays forever. On one
 * development machine that came to 3,698 dirs, about 57 GB, in `%TEMP%`.
 * mongodb-memory-server also stops a server that FAILED to start with
 * `doCleanup: false` ("for investigation"), so a failed boot leaks one too.
 *
 * Three measures, each one usable on its own:
 *
 * 1. `launchMongoMemory` always stops with cleanup, cleans up after a failed
 *    start, and has a synchronous `stopSync()` for a process `exit` handler,
 *    where nothing async completes.
 * 2. `sweepStaleMongoMemoryDirs` removes `mongo-mem-*` dirs that are old AND
 *    whose `mongod.lock` names no live process. Both conditions, always: a live
 *    mongod rewrites its WiredTiger files on every checkpoint (60 s), so its dir
 *    is never old, and its lock names a live pid.
 * 3. `TEST_MONGO_TMPDIR` puts the data dirs under a dedicated base (for example
 *    a project-local `.tmp`), so whatever does leak is contained and visible.
 *
 * Environment:
 * - `TEST_MONGO_TMPDIR`: base dir for new data dirs. Unset: mongodb-memory-server's
 *   own default (`os.tmpdir()`).
 * - `TEST_MONGO_SWEEP_HOURS`: minimum age of a dir the sweep may remove. Default 6.
 *   `0`, `off` or `false` turns the sweep off.
 */

import type { Dirent } from 'node:fs';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Prefix mongodb-memory-server gives its data dirs (and that ours use). */
export const MONGO_MEM_DIR_PREFIX = 'mongo-mem-';
/** Replica-set keyfile dirs: no lock file to prove them dead, so never swept. */
const KEYFILE_DIR_PREFIX = 'mongo-mem-keyfile-';
const HOUR_MS = 3_600_000;
const DEFAULT_MAX_AGE_HOURS = 6;

/** The dedicated base dir from `TEST_MONGO_TMPDIR`, resolved, or undefined. */
export function mongoMemoryTmpBase(): string | undefined {
  const raw = process.env.TEST_MONGO_TMPDIR?.trim();
  return raw ? resolve(raw) : undefined;
}

/** Minimum age (ms) of a dir the sweep may remove; `null` when the sweep is off. */
export function staleMongoMemoryAgeMs(): number | null {
  const raw = process.env.TEST_MONGO_SWEEP_HOURS?.trim().toLowerCase();
  if (raw === '0' || raw === 'off' || raw === 'false') return null;
  const hours = Number(raw);
  return raw && Number.isFinite(hours) && hours > 0
    ? hours * HOUR_MS
    : DEFAULT_MAX_AGE_HOURS * HOUR_MS;
}

/** Whether a process with this pid exists. EPERM means it exists but is not ours. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SweepMongoMemoryOptions {
  /** Dirs to scan. Default: `os.tmpdir()` plus `TEST_MONGO_TMPDIR` when set. */
  readonly dirs?: readonly string[];
  /** Minimum age in ms; `null` turns the sweep off. Default: `staleMongoMemoryAgeMs()`. */
  readonly maxAgeMs?: number | null;
  /** Clock, for tests. Default `Date.now()`. */
  readonly now?: number;
  /** Liveness probe, for tests. Default `isPidAlive`. */
  readonly isAlive?: (pid: number) => boolean;
}

export interface SweepMongoMemoryResult {
  readonly removed: string[];
  readonly kept: Array<{ path: string; reason: 'live-process' | 'recent' }>;
  readonly failed: Array<{ path: string; error: string }>;
}

/** The pid in a data dir's `mongod.lock`. mongod empties it on a clean shutdown. */
async function lockPid(dir: string): Promise<number | undefined> {
  try {
    const pid = Number.parseInt((await readFile(join(dir, 'mongod.lock'), 'utf8')).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Newest mtime of the dir and its direct entries. The dir's own mtime changes
 * only when an entry is added or removed; a live mongod's activity shows in its
 * files (WiredTiger.wt, sizeStorer.wt, the journal), so those count too.
 */
async function newestMtimeMs(dir: string): Promise<number> {
  let newest = (await stat(dir)).mtimeMs;
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    /* unreadable: the dir's own mtime decides */
  }
  for (const name of names) {
    try {
      const { mtimeMs } = await stat(join(dir, name));
      if (mtimeMs > newest) newest = mtimeMs;
    } catch {
      /* vanished while scanning */
    }
  }
  return newest;
}

function defaultSweepDirs(): string[] {
  const base = mongoMemoryTmpBase();
  return base ? [tmpdir(), base] : [tmpdir()];
}

/**
 * Remove abandoned `mongo-mem-*` data dirs.
 *
 * A dir is removed only when BOTH hold: its `mongod.lock` names no live process
 * (or is empty or missing), and nothing in it changed for `maxAgeMs`. Keyfile
 * dirs and anything without the prefix are never touched. Errors are collected,
 * never thrown: a sweep must not fail a test run.
 */
export async function sweepStaleMongoMemoryDirs(
  options: SweepMongoMemoryOptions = {},
): Promise<SweepMongoMemoryResult> {
  const result: SweepMongoMemoryResult = { removed: [], kept: [], failed: [] };
  const maxAgeMs = options.maxAgeMs === undefined ? staleMongoMemoryAgeMs() : options.maxAgeMs;
  if (maxAgeMs === null) return result;
  const now = options.now ?? Date.now();
  const alive = options.isAlive ?? isPidAlive;
  const bases = new Set((options.dirs ?? defaultSweepDirs()).map((d) => resolve(d)));

  for (const base of bases) {
    let entries: Dirent[];
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(MONGO_MEM_DIR_PREFIX)) continue;
      if (entry.name.startsWith(KEYFILE_DIR_PREFIX)) continue;
      const path = join(base, entry.name);
      try {
        const pid = await lockPid(path);
        if (pid !== undefined && alive(pid)) {
          result.kept.push({ path, reason: 'live-process' });
          continue;
        }
        if (now - (await newestMtimeMs(path)) < maxAgeMs) {
          result.kept.push({ path, reason: 'recent' });
          continue;
        }
        await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        result.removed.push(path);
      } catch (err) {
        result.failed.push({ path, error: (err as Error).message });
      }
    }
  }
  return result;
}

let processSweep: Promise<SweepMongoMemoryResult> | undefined;
/**
 * Run the sweep at most once per process, in the background. Started before a
 * process boots its first server; never awaited there, because a first sweep
 * after a long leak can have gigabytes to delete. Logs one line when it removed
 * anything, so a machine that keeps leaking is noticed.
 */
export function sweepStaleMongoMemoryDirsOnce(
  label = 'mongokit/testkit',
): Promise<SweepMongoMemoryResult> {
  processSweep ??= sweepStaleMongoMemoryDirs().then(
    (r) => {
      if (r.removed.length > 0) {
        console.warn(
          `[${label}] removed ${r.removed.length} abandoned mongo-mem-* temp dir(s) left by killed or crashed test runs`,
        );
      }
      return r;
    },
    () => ({ removed: [], kept: [], failed: [] }),
  );
  return processSweep;
}

// ─── Launch / stop ──────────────────────────────────────────────────────────

/** The parts of a mongodb-memory-server instance this module reads. */
interface MmsInstanceLike {
  readonly instanceInfo?: {
    readonly tmpDir?: string;
    readonly instance?: { readonly mongodProcess?: { readonly pid?: number } | undefined };
  };
}

/** The parts of `MongoMemoryServer` / `MongoMemoryReplSet` this module uses. */
export interface MmsServerLike {
  getUri(dbName?: string): string;
  start(): Promise<unknown>;
  stop(cleanup?: { doCleanup?: boolean; force?: boolean }): Promise<unknown>;
}

export type MongoMemoryKind = 'standalone' | 'replset';

export interface LaunchedMongoMemory<S extends MmsServerLike> {
  readonly server: S;
  /** Data dirs this module created under `TEST_MONGO_TMPDIR` (empty when unset). */
  readonly ownedDirs: readonly string[];
  /**
   * Stop and remove the data dirs. Idempotent once it succeeded; a failed stop
   * rejects and can be retried, and `stopSync()` stays effective until one succeeds.
   */
  stop(): Promise<void>;
  /**
   * Best-effort SYNCHRONOUS stop for a process `exit` handler, where no async
   * work completes: kill the mongod processes and remove their data dirs.
   * Idempotent, never throws.
   */
  stopSync(): void;
}

async function newDataDir(base: string): Promise<string> {
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, MONGO_MEM_DIR_PREFIX));
}

/**
 * Point every member at a fresh dir under `base`, unless the caller set its own
 * `dbPath` / `instanceOpts` (then the caller owns that location).
 */
async function withDedicatedDataDirs(
  kind: MongoMemoryKind,
  opts: Record<string, unknown>,
  base: string,
  owned: string[],
): Promise<Record<string, unknown>> {
  if (kind === 'standalone') {
    const instance = (opts.instance ?? {}) as Record<string, unknown>;
    if (instance.dbPath !== undefined) return opts;
    const dbPath = await newDataDir(base);
    owned.push(dbPath);
    return { ...opts, instance: { ...instance, dbPath } };
  }
  const existing = opts.instanceOpts as unknown[] | undefined;
  if (existing && existing.length > 0) return opts;
  const count = Number((opts.replSet as { count?: number } | undefined)?.count ?? 1);
  const instanceOpts: Array<{ dbPath: string }> = [];
  for (let i = 0; i < Math.max(1, count); i += 1) {
    const dbPath = await newDataDir(base);
    owned.push(dbPath);
    instanceOpts.push({ dbPath });
  }
  return { ...opts, instanceOpts };
}

function instancesOf(server: unknown): MmsInstanceLike[] {
  const members = (server as { servers?: MmsInstanceLike[] }).servers;
  return Array.isArray(members) ? members : [server as MmsInstanceLike];
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
/** Synchronous sleep, for the `exit` path where no timer fires. */
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

/**
 * Remove a dir synchronously, retrying for up to `timeoutMs`. A killed mongod
 * is reported gone before Windows releases its file handles, so the first
 * attempts can fail with EPERM / EBUSY.
 */
function removeDirSync(dir: string, timeoutMs = 0): void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (Date.now() >= deadline) return; // best effort: the next run's sweep gets it
      sleepSync(50);
    }
  }
}

/** Block until none of `pids` is alive, at most `timeoutMs`. */
function waitForExitSync(pids: readonly number[], timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isPidAlive) && Date.now() < deadline) sleepSync(25);
}

/**
 * Create and start a `MongoMemoryServer` (`standalone`) or `MongoMemoryReplSet`
 * (`replset`) with the cleanup guarantees described at the top of this file.
 *
 * `Ctor` is the class itself, so a caller that loads mongodb-memory-server its
 * own way (by resolved path, through an alias) keeps doing so.
 */
export async function launchMongoMemory<S extends MmsServerLike>(
  Ctor: new (opts?: never) => S,
  kind: MongoMemoryKind,
  createOptions: Record<string, unknown> = {},
): Promise<LaunchedMongoMemory<S>> {
  const base = mongoMemoryTmpBase();
  const ownedDirs: string[] = [];
  const opts = base
    ? await withDedicatedDataDirs(kind, createOptions, base, ownedDirs)
    : createOptions;
  // `force: true` is mongodb-memory-server's switch for removing a dbPath it
  // did not create; only set when the dirs are ours.
  const cleanup = { doCleanup: true, force: ownedDirs.length > 0 };

  const server = new Ctor(opts as never);
  try {
    await server.start();
  } catch (err) {
    // mongodb-memory-server stops a failed start with `doCleanup: false`, which
    // keeps the data dir "for investigation" and leaks it. Clean up here.
    await server.stop(cleanup).catch(() => undefined);
    for (const dir of ownedDirs) removeDirSync(dir, 2_000);
    throw err;
  }

  // `stopped` turns true only once a stop SUCCEEDED (mongod gone, dirs removed): a failed stop
  // leaves the server retryable by `stop()` and still covered by `stopSync()`.
  let stopped = false;
  let stopping: Promise<void> | undefined;
  return {
    server,
    ownedDirs,
    stop() {
      if (stopped) return Promise.resolve();
      // One stop at a time; concurrent callers share it.
      stopping ??= (async () => {
        try {
          const ok = await server.stop(cleanup);
          // A replica set reports a member it could not stop as `false`; a standalone
          // answers `false` only when it never ran (nothing left to stop).
          if (ok === false && kind === 'replset') {
            throw new Error(
              '[mongokit/testkit] mongodb-memory-server could not stop every replica-set member; ' +
                'stop() can be retried, and the process-exit fallback still covers it',
            );
          }
          // `force: true` already removed them; this only catches a dir a member
          // never reached. Not reached after a failed stop: mongod may still use it.
          for (const dir of ownedDirs) removeDirSync(dir);
          stopped = true;
        } finally {
          stopping = undefined;
        }
      })();
      return stopping;
    },
    stopSync() {
      if (stopped) return;
      stopped = true;
      const dirs = new Set(ownedDirs);
      const pids: number[] = [];
      for (const member of instancesOf(server)) {
        const info = member.instanceInfo;
        const pid = info?.instance?.mongodProcess?.pid;
        if (pid) {
          pids.push(pid);
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
        if (info?.tmpDir) dirs.add(info.tmpDir);
      }
      // A killed process releases its files only once it is gone (on Windows
      // they stay locked until then), so wait for that before removing.
      waitForExitSync(pids, 5_000);
      for (const dir of dirs) removeDirSync(dir, 5_000);
    },
  };
}

// ─── Process-exit tracking (for callers without their own handlers) ─────────

const tracked = new Set<LaunchedMongoMemory<MmsServerLike>>();
let exitHooked = false;

/**
 * Stop a launched server when the process ends without its teardown: Ctrl-C /
 * SIGTERM stop it properly, then re-raise so the exit code stays truthful; an
 * `exit` (including an uncaught exception) kills mongod and removes the dir
 * synchronously. Returns an untrack function for the orderly path.
 */
export function stopOnProcessExit(handle: LaunchedMongoMemory<MmsServerLike>): () => void {
  tracked.add(handle);
  if (!exitHooked) {
    exitHooked = true;
    const onSignal = (signal: NodeJS.Signals) => {
      // A handle leaves the list only once its stop succeeded. One that failed gets the
      // synchronous stop before the signal is re-raised: a signal's default exit emits no
      // `exit` event, so that handler would never see it.
      const all = [...tracked];
      void Promise.all(
        all.map((h) =>
          h.stop().then(
            () => {
              tracked.delete(h);
            },
            () => undefined,
          ),
        ),
      ).finally(() => {
        for (const h of all) {
          if (!tracked.has(h)) continue;
          h.stopSync();
          tracked.delete(h);
        }
        process.removeListener(signal, onSignal);
        process.kill(process.pid, signal);
      });
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
      process.once(signal, onSignal);
    }
    process.once('exit', () => {
      for (const h of tracked) h.stopSync();
      tracked.clear();
    });
  }
  return () => {
    tracked.delete(handle);
  };
}
