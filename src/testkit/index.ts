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

// ─── Options ─────────────────────────────────────────────────────────────────

export interface MongoMemoryOptions {
  /**
   * Boot a single-node replica set instead of a standalone mongod. Required for
   * any code that opens a `session.startTransaction()` — a standalone server
   * rejects it with error 263. Slightly slower to start (~2-3s). Default false.
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
  /** Stop the in-memory server. No-op for an external URI. Idempotent. */
  stop(): Promise<void>;
}

function idempotentStop(server: { stop(): Promise<unknown> }): () => Promise<void> {
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    await server.stop().catch(() => undefined);
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

  if (options.replset) {
    const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    return { uri: rs.getUri(dbName), server: rs, stop: idempotentStop(rs) };
  }
  const server = await MongoMemoryServer.create();
  return { uri: server.getUri(dbName), server, stop: idempotentStop(server) };
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
      closed = true;
      await connection.close().catch(() => undefined);
      await handle.stop();
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
