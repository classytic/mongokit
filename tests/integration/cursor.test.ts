/**
 * `Repository.cursor()` — streaming reads with tenant scope.
 *
 * Replaces direct `Model.find().cursor()` usage which bypasses every
 * plugin (cross-tenant data leak waiting to happen). Goes through the
 * standard `before:cursor` hook pipeline so multi-tenant scope, soft-
 * delete, and access-control plugins inject before the underlying
 * mongoose cursor is built.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { multiTenantPlugin } from '../../src/plugins/multi-tenant.plugin.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IDoc {
  _id?: mongoose.Types.ObjectId;
  organizationId: string;
  name: string;
  status: 'active' | 'archived';
}

describe('Repository.cursor — streaming reads with tenant scope', () => {
  let Model: mongoose.Model<IDoc>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'CursorDoc',
      new Schema<IDoc>({
        organizationId: { type: String, required: true, index: true },
        name: { type: String, required: true },
        status: { type: String, required: true },
      }),
    );
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });
  beforeEach(async () => {
    await Model.deleteMany({});
  });

  it('iterates all matching docs', async () => {
    const repo = new Repository<IDoc>(Model);
    await repo.create({ organizationId: 'org-a', name: 'A', status: 'active' });
    await repo.create({ organizationId: 'org-a', name: 'B', status: 'active' });
    await repo.create({ organizationId: 'org-a', name: 'C', status: 'archived' });

    const seen: string[] = [];
    for await (const doc of repo.cursor({ status: 'active' })) {
      seen.push(doc.name);
    }
    expect(seen.sort()).toEqual(['A', 'B']);
  });

  it('respects multi-tenant scope — never yields cross-tenant docs', async () => {
    const repo = new Repository<IDoc>(Model, [
      multiTenantPlugin({ tenantField: 'organizationId', required: true }),
    ]);
    // Seed docs across two tenants directly (bypass plugin for setup).
    await Model.create([
      { organizationId: 'org-a', name: 'A1', status: 'active' },
      { organizationId: 'org-a', name: 'A2', status: 'active' },
      { organizationId: 'org-b', name: 'B1', status: 'active' },
      { organizationId: 'org-b', name: 'B2', status: 'active' },
    ]);

    const seen: string[] = [];
    for await (const doc of repo.cursor({}, { organizationId: 'org-a' })) {
      seen.push(doc.name);
    }
    expect(seen.sort()).toEqual(['A1', 'A2']);
  });

  it('honors sort + batchSize', async () => {
    const repo = new Repository<IDoc>(Model);
    await repo.createMany([
      { organizationId: 'org-a', name: 'C', status: 'active' },
      { organizationId: 'org-a', name: 'A', status: 'active' },
      { organizationId: 'org-a', name: 'B', status: 'active' },
    ]);

    const seen: string[] = [];
    for await (const doc of repo.cursor({}, { sort: { name: 1 }, batchSize: 2 })) {
      seen.push(doc.name);
    }
    expect(seen).toEqual(['A', 'B', 'C']);
  });

  it('emits after:cursor with the yielded count when iteration completes', async () => {
    const repo = new Repository<IDoc>(Model);
    await repo.createMany([
      { organizationId: 'org-a', name: 'A', status: 'active' },
      { organizationId: 'org-a', name: 'B', status: 'active' },
    ]);

    let afterCount: number | undefined;
    repo.on('after:cursor', (data: { result: { count: number } }) => {
      afterCount = data.result.count;
    });

    const seen: string[] = [];
    for await (const doc of repo.cursor({})) {
      seen.push(doc.name);
    }
    expect(afterCount).toBe(2);
  });

  it('propagates consumer errors out of the for-await without hanging the cursor', async () => {
    // Documented semantic: a throw INSIDE the consumer's `for await` body
    // is the CONSUMER'S error, not a cursor error — the generator's
    // try/catch does NOT fire (JS calls `iterator.return()` for cleanup,
    // not `iterator.throw()`). `error:cursor` is reserved for stream-
    // level driver failures; consumer errors propagate via the normal
    // throw path. The cursor's finally block still closes the underlying
    // mongoose cursor — no hang, no resource leak.
    const repo = new Repository<IDoc>(Model);
    await repo.create({ organizationId: 'org-a', name: 'A', status: 'active' });

    let thrown: Error | undefined;
    try {
      for await (const _doc of repo.cursor({})) {
        throw new Error('consumer-blew-up');
      }
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toContain('consumer-blew-up');
  });

  it('handles early break — closes the cursor without leaking', async () => {
    const repo = new Repository<IDoc>(Model);
    await repo.createMany([
      { organizationId: 'org-a', name: 'A', status: 'active' },
      { organizationId: 'org-a', name: 'B', status: 'active' },
      { organizationId: 'org-a', name: 'C', status: 'active' },
    ]);

    const seen: string[] = [];
    for await (const doc of repo.cursor({}, { sort: { name: 1 } })) {
      seen.push(doc.name);
      if (seen.length === 2) break;
    }
    expect(seen).toEqual(['A', 'B']);
    // No assertion on resource leak — just the test completing without
    // hangs / unhandled-rejection warnings is the verification.
  });

  it('plugin hooks fire before the cursor is built (tenant scope wins over caller filter)', async () => {
    const repo = new Repository<IDoc>(Model, [
      multiTenantPlugin({ tenantField: 'organizationId', required: false }),
    ]);
    await Model.create([
      { organizationId: 'org-a', name: 'A', status: 'active' },
      { organizationId: 'org-b', name: 'B', status: 'active' },
    ]);

    // Caller passes status filter; plugin injects organizationId.
    const seen: string[] = [];
    for await (const doc of repo.cursor({ status: 'active' }, { organizationId: 'org-a' })) {
      seen.push(doc.name);
    }
    expect(seen).toEqual(['A']);
  });
});
