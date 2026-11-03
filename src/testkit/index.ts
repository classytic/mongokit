/**
 * `@classytic/mongokit/testkit` — in-memory MongoDB test harness.
 *
 * Spin up a real (ephemeral) MongoDB for tests — standalone, or a single-node
 * replica set when the code under test uses multi-document transactions — with:
 *
 *   - `createMongoMemory`    — the raw server lifecycle (uri + stop).
 *   - `createTestConnection` — an ISOLATED mongoose connection over it
 *                              (`createConnection`, never the global singleton,
 *                              so parallel/ repeated boots never collide).
 *   - `withMongoMemory`      — scoped setup → fn → teardown (try/finally).
 *   - `createTestRepository` — memory server + connection + a live mongokit
 *                              `Repository` in one call.
 *   - `mongoMemoryBackend`   — a `TestBackend` seam that drops straight into
 *                              `@classytic/arc-testkit`'s `bootModuleApp`.
 *
 * `mongodb-memory-server` is an OPTIONAL peer — the consuming project installs
 * it in its own devDependencies. It is loaded via dynamic `import()` so merely
 * importing this module never requires it until a helper actually runs; mongokit
 * itself stays dependency-free in production.
 *
 * External MongoDB: pass `{ uri }`, or set `MONGODB_URI`, and no in-memory
 * server is started — the caller owns that lifecycle (mirrors mongokit's own
 * `MONGODB_URI` test convention). Handy for running the same suite against a
 * real replica set or CI cluster.
 */

import type { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import type { Connection, Model, Schema } from 'mongoose';
import { createConnection } from 'mongoose';
import type { CreateRepositoryConfig } from '../create-repository.js';
import { createRepository } from '../create-repository.js';
import type { Repository } from '../Repository.js';
import {
  type LaunchedMongoMemory,
  launchMongoMemory,
  type MmsServerLike,
  stopOnProcessExit,
  sweepStaleMongoMemoryDirsOnce,
} from './mongo-tmp.js';

// ─── Options ─────────────────────────────────────────────────────────────────

export interface MongoMemoryOptions {
  /**
   * Boot a single-node replica set instead of a standalone mongod. Required for
   * any code that opens a `session.startTransaction()` — a standalone server
   * rejects it with error 263. Slightly slower to start (~2-3s). Default false.
   *
   * Since 2026-08-05 this also changes what `repo.capabilities` REPORTS:
   * capabilities are observed from the live topology, so a standalone harness
   * yields `transactions: false` and any kernel boot gate built on it will
   * (correctly) refuse to bind. Set `replset: true` when the code under test
   * constructs a money kernel — or pass that kernel's `allowNonTransactional`.
   */
  replset?: boolean;
  /** Database name baked into the generated URI. Default `"mongokit-test"`. */
  dbName?: string;
  /**
   * Use this URI instead of spinning an in-memory server (real MongoDB, CI
   * replica set). Falls back to `process.env.MONGODB_URI`. When either is set,
   * `stop()` is a no-op — the caller owns the server's lifecycle.
   */
  uri?: string;
}

// ─── Raw server lifecycle ────────────────────────────────────────────────────

export interface MongoMemoryHandle {
  /** Connection string for the running (or external) server. */
  uri: string;
  /** The in-memory server; `undefined` when an external `uri` is used. */
  server?: MongoMemoryServer | MongoMemoryReplSet;
  /**
   * Stop the in-memory server. No-op for an external URI. Idempotent once it
   * succeeded; a failed stop rejects and can be retried, and the server stays
   * on the process-exit list (killed synchronously on exit) until one succeeds.
   */
  stop(): Promise<void>;
}

/**
 * Stop with cleanup; leave the process-exit list only once that SUCCEEDED. A failed
 * stop rejects, keeps the exit tracking, and a later call retries.
 */
function idempotentStop(
  launched: LaunchedMongoMemory<MmsServerLike>,
  untrack: () => void,
): () => Promise<void> {
  let stopped = false;
  let stopping: Promise<void> | undefined;
  return () => {
    if (stopped) return Promise.resolve();
    stopping ??= launched
      .stop()
      .then(() => {
        stopped = true;
        untrack();
      })
      .finally(() => {
        stopping = undefined;
      });
    return stopping;
  };
}

/**
 * Start an ephemeral MongoDB (or resolve an external one) and return its URI +
 * a `stop()` teardown. Prefer `createTestConnection` / `createTestRepository`
 * unless you need the server without a mongoose connection.
 */
export async function createMongoMemory(
  options: MongoMemoryOptions = {},
): Promise<MongoMemoryHandle> {
  const externalUri = options.uri ?? process.env.MONGODB_URI;
  if (externalUri) {
    return { uri: externalUri, stop: async () => undefined };
  }

  // Dynamic import keeps `mongodb-memory-server` an OPTIONAL peer — importing
  // this module never pulls it until a helper that starts a server runs.
  const { MongoMemoryServer, MongoMemoryReplSet } = await import('mongodb-memory-server');
  const dbName = options.dbName ?? 'mongokit-test';

  // Data dirs left by killed or crashed runs: swept once per process, in the
  // background, never a live server's. See `./mongo-tmp.ts`.
  void sweepStaleMongoMemoryDirsOnce();

  // `launchMongoMemory`, not `create()`: stop always cleans up (also after a
  // failed start), `TEST_MONGO_TMPDIR` is honoured, and the server is stopped
  // when the process exits or is interrupted before `stop()` is called.
  if (options.replset) {
    const launched = await launchMongoMemory(MongoMemoryReplSet, 'replset', {
      replSet: { count: 1 },
    });
    const untrack = stopOnProcessExit(launched);
    return {
      uri: launched.server.getUri(dbName),
      server: launched.server,
      stop: idempotentStop(launched, untrack),
    };
  }
  const launched = await launchMongoMemory(MongoMemoryServer, 'standalone');
  const untrack = stopOnProcessExit(launched);
  return {
    uri: launched.server.getUri(dbName),
    server: launched.server,
    stop: idempotentStop(launched, untrack),
  };
}

// ─── Isolated connection ─────────────────────────────────────────────────────

export interface TestConnection {
  /** An isolated mongoose connection (never the global `mongoose.connection`). */
  connection: Connection;
  uri: string;
  /** Empty every collection on this connection — call in `beforeEach`. */
  clear(): Promise<void>;
  /** Close the connection and stop the server. Idempotent. */
  close(): Promise<void>;
}

/** Drop every document in every collection on a connection (models preserved). */
export async function clearCollections(connection: Connection): Promise<void> {
  const collections = await connection.db?.collections();
  if (!collections) return;
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

/**
 * Start (or resolve) a server AND open an isolated mongoose connection over it.
 * Each call gets its own connection — model registries are per-connection, so
 * repeated boots in one process never collide.
 */
export async function createTestConnection(
  options: MongoMemoryOptions = {},
): Promise<TestConnection> {
  const handle = await createMongoMemory(options);
  const connection = await createConnection(handle.uri).asPromise();
  let closed = false;
  return {
    connection,
    uri: handle.uri,
    clear: () => clearCollections(connection),
    close: async () => {
      if (closed) return;
      await connection.close().catch(() => undefined);
      // Closed only once the server stopped: a failed stop rejects and close() can be retried.
      await handle.stop();
      closed = true;
    },
  };
}

/**
 * Scoped harness: start a connection, run `fn`, and tear down in a `finally`
 * even if `fn` throws.
 *
 * ```ts
 * await withMongoMemory(async ({ connection }) => {
 *   const repo = createRepository(connection.model("User", userSchema));
 *   // ... assertions ...
 * });
 * ```
 */
export async function withMongoMemory<T>(
  fn: (ctx: TestConnection) => Promise<T> | T,
  options: MongoMemoryOptions = {},
): Promise<T> {
  const ctx = await createTestConnection(options);
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

// ─── One-call repository ─────────────────────────────────────────────────────

export interface CreateTestRepositoryOptions<TDoc> extends MongoMemoryOptions {
  /** Model / collection name (unique per test to avoid cross-file collisions). */
  name: string;
  /** Mongoose schema for the model. */
  schema: Schema<TDoc>;
  /** mongokit `createRepository` config — tenant, softDelete, plugins, cache… */
  config?: CreateRepositoryConfig;
}

export interface TestRepository<TDoc> {
  /** A live mongokit repository over an in-memory collection. */
  repository: Repository<TDoc>;
  /** The underlying mongoose model (bound to the isolated connection). */
  model: Model<TDoc>;
  connection: Connection;
  uri: string;
  /** Empty this repository's collection. */
  clear(): Promise<void>;
  /** Close the connection and stop the server. Idempotent. */
  close(): Promise<void>;
}

/**
 * The fast path for testing a mongokit repository: spins an in-memory server,
 * opens an isolated connection, registers the model on it, builds indexes, and
 * returns a ready `Repository` (plus `clear()` / `close()`).
 *
 * ```ts
 * const t = await createTestRepository({ name: "Order", schema: orderSchema,
 *   config: { softDelete: true } });
 * await t.repository.create({ total: 10 });
 * await t.close();
 * ```
 */
export async function createTestRepository<TDoc>(
  options: CreateTestRepositoryOptions<TDoc>,
): Promise<TestRepository<TDoc>> {
  const tc = await createTestConnection(options);
  const model = tc.connection.model<TDoc>(options.name, options.schema);
  await model.init(); // build indexes so unique/index behavior is real
  const repository = createRepository<TDoc>(model, options.config);
  return {
    repository,
    model,
    connection: tc.connection,
    uri: tc.uri,
    clear: async () => {
      await model.deleteMany({});
    },
    close: tc.close,
  };
}

// ─── arc-testkit backend seam ────────────────────────────────────────────────

/** The context a module receives from the Mongo backend (live connection + URI). */
export interface MongoTestContext {
  connection: Connection;
  uri: string;
}

/**
 * A backend usable by `@classytic/arc-testkit`'s `bootModuleApp`. Structurally
 * a `TestBackend<MongoTestContext>` — no import of arc-testkit, so mongokit
 * never depends on it (one-way: arc-testkit consumes this by shape).
 */
export interface MongoMemoryBackend {
  setup(): Promise<{ ctx: MongoTestContext; teardown: () => Promise<void> }>;
}

/**
 * A real in-memory Mongo backend for arc-testkit:
 *
 * ```ts
 * import { bootModuleApp } from "@classytic/arc-testkit";
 * import { mongoMemoryBackend } from "@classytic/mongokit/testkit";
 *
 * const t = await bootModuleApp(
 *   ({ connection }) => [createAccountingModule({ connection, permissions })],
 *   { backend: mongoMemoryBackend() },
 * );
 * ```
 */
export function mongoMemoryBackend(options: MongoMemoryOptions = {}): MongoMemoryBackend {
  return {
    async setup() {
      const tc = await createTestConnection(options);
      return {
        ctx: { connection: tc.connection, uri: tc.uri },
        teardown: tc.close,
      };
    },
  };
}

// ─── Temp-dir hygiene (abandoned mongo-mem-* dirs) ───────────────────────────

export {
  isPidAlive,
  type LaunchedMongoMemory,
  launchMongoMemory,
  type MmsServerLike,
  MONGO_MEM_DIR_PREFIX,
  type MongoMemoryKind,
  mongoMemoryTmpBase,
  type SweepMongoMemoryOptions,
  type SweepMongoMemoryResult,
  staleMongoMemoryAgeMs,
  stopOnProcessExit,
  sweepStaleMongoMemoryDirs,
} from './mongo-tmp.js';

// ─── Command recording + query-plan gate ─────────────────────────────────────

export {
  assertQueryPlan,
  type ExplainCommandsOptions,
  type ExplainedCommand,
  explainCommands,
  type PlannedCommand,
  type QueryPlanOptions,
  type RecordedCommand,
  recordCommands,
} from './query-plan.js';
