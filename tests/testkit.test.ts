/**
 * `@classytic/mongokit/testkit` — contract tests.
 *
 * Exercises the harness surface (isolated connection, one-call repository,
 * scoped runner, arc-testkit backend seam) against whatever server the suite
 * provides. Under `npm test` the shared replica set is already up (globalSetup
 * sets `MONGODB_URI`), so these run the external-URI path; the in-memory
 * spin-up path is covered by the standalone smoke. Either way the API contract
 * is identical.
 */

import mongoose from 'mongoose';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMongoMemory,
  createTestConnection,
  createTestRepository,
  mongoMemoryBackend,
  withMongoMemory,
} from '../src/testkit/index.js';

// Track anything a test opens so a failed assertion never leaks a connection.
const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (opened.length) await opened.pop()?.close();
});

describe('mongokit/testkit', () => {
  it('createTestRepository builds a live repository (create → getById → clear)', async () => {
    const schema = new mongoose.Schema({ name: String, total: Number });
    const t = await createTestRepository<{ name: string; total: number }>({
      name: 'TestkitOrder',
      schema,
    });
    opened.push(t);

    const created = await t.repository.create({ name: 'a', total: 10 });
    const id = String(
      (created as { _id?: unknown; id?: unknown })._id ?? (created as { id?: unknown }).id,
    );
    const found = await t.repository.getById(id);
    expect(found).toBeTruthy();
    expect((found as { name?: string } | null)?.name).toBe('a');

    await t.clear();
    expect(await t.model.countDocuments({})).toBe(0);
  });

  it('createTestConnection yields an isolated connection; close() is idempotent', async () => {
    const tc = await createTestConnection();
    expect(tc.connection.readyState).toBe(1); // connected
    expect(typeof tc.uri).toBe('string');
    await tc.close();
    await tc.close(); // second call must not throw
    expect(tc.connection.readyState).not.toBe(1);
  });

  it('withMongoMemory runs the fn and tears the connection down after', async () => {
    let captured: mongoose.Connection | undefined;
    const count = await withMongoMemory(async ({ connection }) => {
      captured = connection;
      const m = connection.model('TestkitScoped', new mongoose.Schema({ x: Number }));
      await m.create({ x: 1 });
      return m.countDocuments({});
    });
    expect(count).toBe(1);
    expect(captured?.readyState).not.toBe(1); // closed by the finally
  });

  it('mongoMemoryBackend exposes the arc-testkit { setup → ctx, teardown } shape', async () => {
    const backend = mongoMemoryBackend();
    const { ctx, teardown } = await backend.setup();
    expect(ctx.connection.readyState).toBe(1);
    expect(typeof ctx.uri).toBe('string');
    await teardown();
    expect(ctx.connection.readyState).not.toBe(1);
  });

  it('createMongoMemory honors an explicit uri (external server, no-op stop)', async () => {
    const handle = await createMongoMemory({ uri: 'mongodb://localhost:27017/never-connected' });
    expect(handle.uri).toBe('mongodb://localhost:27017/never-connected');
    expect(handle.server).toBeUndefined();
    await handle.stop(); // must be a no-op, not an error
  });
});
