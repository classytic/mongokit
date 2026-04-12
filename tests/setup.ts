/**
 * Per-file test setup helpers.
 *
 * When a vitest `globalSetup` has already started a shared MongoMemoryServer
 * (the default for `npm test`), these helpers:
 *
 *   - connectDB()     — idempotent connect to the shared URI. O(ms) after the
 *                       first file in a fork.
 *   - disconnectDB()  — NO-OP. The shared server is owned by globalSetup.
 *                       Leaving mongoose connected across files inside a fork
 *                       is what actually makes the suite fast (~10x vs the
 *                       old per-file start/stop).
 *   - clearDB()       — empties every collection on the current connection.
 *
 * Legacy path (no globalSetup, no MONGODB_URI — e.g. running a single file
 * via `vitest run --no-global-setup` or a custom runner) still works: the
 * first `connectDB()` lazily creates its own memory server, and
 * `disconnectDB()` tears it down.
 *
 * Test files remain independent because each constructs unique collection
 * names via `createTestModel('UniquePrefix…', schema)`. Parallel forks are
 * therefore collision-free as long as that convention holds.
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let ownedServer: MongoMemoryServer | null = null;
let effectiveMongoUri: string | null = null;

function isSharedServerMode(): boolean {
  // globalSetup sets MONGOKIT_TEST_SHARED_SERVER=1 alongside MONGODB_URI.
  // A bare MONGODB_URI (user-provided) is also treated as shared — we don't
  // own it and must not stop it.
  return !!process.env.MONGODB_URI;
}

/**
 * Connect mongoose to the shared (or legacy per-file) memory server.
 * Idempotent — safe to call from every `beforeAll`.
 */
export async function connectDB(): Promise<void> {
  if (mongoose.connection.readyState !== 0) return;

  if (!effectiveMongoUri) {
    if (process.env.MONGODB_URI) {
      effectiveMongoUri = process.env.MONGODB_URI;
    } else {
      ownedServer = await MongoMemoryServer.create();
      effectiveMongoUri = ownedServer.getUri('mongokit-test');
    }
  }

  await mongoose.connect(effectiveMongoUri);
}

/**
 * No-op in shared-server mode; full teardown only when this file is the
 * sole owner of the memory server.
 */
export async function disconnectDB(): Promise<void> {
  if (isSharedServerMode()) {
    // globalSetup owns the lifecycle. Leave mongoose + server alone so the
    // next file in this fork can reuse the existing connection.
    return;
  }

  await mongoose.disconnect();
  if (ownedServer) {
    await ownedServer.stop();
    ownedServer = null;
  }
  effectiveMongoUri = null;
}

/**
 * Drop every document in every collection on the current connection.
 * Use in `beforeEach` when tests need a clean slate but want to preserve
 * registered models.
 */
export async function clearDB(): Promise<void> {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
}

/**
 * Register (or re-register) a Mongoose model for the current connection.
 *
 * Convention for test authoring: always prefix the model name with the test
 * file's subject (e.g. `DeleteModeCustomer`, `CascadeRoutedProduct`). This
 * prevents collection-name collisions when forks run in parallel AND when
 * files share a fork.
 */
export async function createTestModel<T>(
  name: string,
  schema: mongoose.Schema<T>,
): Promise<mongoose.Model<T>> {
  // Delete any previously-registered model of the same name so re-registration
  // with a fresh schema works across test files within a fork.
  if (mongoose.models[name]) {
    delete mongoose.models[name];
  }
  const model = mongoose.model<T>(name, schema);
  await model.init();
  return model;
}
