/**
 * `repo.useMiddleware(mw)` — wrap-style middleware (Prisma `$extends.query`
 * shape). Composes around every `_runOp` invocation and runs alongside
 * the existing before/after/error hook engine — middleware doesn't
 * REPLACE hooks, it WRAPS them.
 *
 * Pinned behaviors:
 *  - Outer-most-first composition order (registration order)
 *  - Input mutation via `context.data` before `next()`
 *  - Output mutation via the resolved value of `await next()`
 *  - Short-circuit (return without calling `next()`)
 *  - Error propagation up the chain via plain try/catch
 *  - Hooks keep firing from inside `next()` (multi-tenant scope etc.)
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repository, type Middleware } from '../../src/index.js';
import { multiTenantPlugin } from '../../src/plugins/multi-tenant.plugin.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IDoc {
  _id?: mongoose.Types.ObjectId;
  organizationId: string;
  name: string;
  status?: string;
}

describe('Repository.useMiddleware — wrap-style additive API', () => {
  let Model: mongoose.Model<IDoc>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'MiddlewareDoc',
      new Schema<IDoc>({
        organizationId: { type: String, required: true, index: true },
        name: { type: String, required: true },
        status: { type: String },
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

  it('runs around every op (timing pattern)', async () => {
    const repo = new Repository<IDoc>(Model);
    const calls: Array<{ op: string; took: number }> = [];

    repo.useMiddleware(async ({ operation, next }) => {
      const start = performance.now();
      const result = await next();
      calls.push({ op: operation, took: performance.now() - start });
      return result;
    });

    await repo.create({ organizationId: 'org-a', name: 'A' });
    const created = await repo.create({ organizationId: 'org-a', name: 'B' });
    await repo.getById(String(created._id));

    const ops = calls.map((c) => c.op);
    expect(ops).toEqual(['create', 'create', 'getById']);
    for (const c of calls) expect(c.took).toBeGreaterThanOrEqual(0);
  });

  it('mutates input via context.data before next()', async () => {
    const repo = new Repository<IDoc>(Model);

    repo.useMiddleware(async ({ operation, context, next }) => {
      if (operation === 'create' && context.data) {
        context.data.status = 'auto-stamped';
      }
      return next();
    });

    const created = await repo.create({ organizationId: 'org-a', name: 'A' });
    // Middleware-injected status persists in the DB.
    const reread = await repo.getById(String(created._id));
    expect(reread?.status).toBe('auto-stamped');
  });

  it('mutates output by transforming the resolved value', async () => {
    const repo = new Repository<IDoc>(Model);

    repo.useMiddleware(async ({ operation, next }) => {
      const result = await next();
      if (operation === 'getById' && result && typeof result === 'object') {
        return { ...(result as Record<string, unknown>), name: 'TRANSFORMED' };
      }
      return result;
    });

    const created = await repo.create({ organizationId: 'org-a', name: 'original' });
    const found = await repo.getById(String(created._id));
    expect(found?.name).toBe('TRANSFORMED');
  });

  it('short-circuits when middleware returns without calling next()', async () => {
    const repo = new Repository<IDoc>(Model);
    const created = await repo.create({ organizationId: 'org-a', name: 'real' });

    repo.useMiddleware(async ({ operation, context, next }) => {
      if (operation === 'getById' && context.id === 'sentinel') {
        return { _id: 'sentinel', organizationId: 'fake', name: 'short-circuit' };
      }
      return next();
    });

    const real = await repo.getById(String(created._id));
    expect(real?.name).toBe('real');

    const sentinel = await repo.getById('sentinel' as unknown as mongoose.Types.ObjectId);
    expect((sentinel as unknown as { name: string })?.name).toBe('short-circuit');
  });

  it('composes registration-order = outermost-first', async () => {
    const repo = new Repository<IDoc>(Model);
    const order: string[] = [];

    // Outer middleware (registered first).
    repo.useMiddleware(async ({ next }) => {
      order.push('outer:before');
      const result = await next();
      order.push('outer:after');
      return result;
    });
    // Inner middleware.
    repo.useMiddleware(async ({ next }) => {
      order.push('inner:before');
      const result = await next();
      order.push('inner:after');
      return result;
    });

    await repo.create({ organizationId: 'org-a', name: 'A' });
    expect(order).toEqual(['outer:before', 'inner:before', 'inner:after', 'outer:after']);
  });

  it('errors thrown inside next() propagate to outer middleware', async () => {
    const repo = new Repository<IDoc>(Model);
    const errors: string[] = [];

    repo.useMiddleware(async ({ next }) => {
      try {
        return await next();
      } catch (err) {
        errors.push((err as Error).message);
        throw err;
      }
    });

    // Trigger a Mongoose validation error — `name` is required.
    await expect(
      repo.create({ organizationId: 'org-a' } as unknown as Partial<IDoc>),
    ).rejects.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/validation|required/i);
  });

  it('after-hooks fire inside next() — middleware composes with plugins, not replaces', async () => {
    // Multi-tenant plugin scopes filters via `before:create` and stamps
    // `data[tenantField]`. Confirm middleware sees the post-stamp data
    // (i.e., hooks ran from within `next()`).
    const repo = new Repository<IDoc>(Model, [
      multiTenantPlugin({ tenantField: 'organizationId', required: false }),
    ]);

    let observedOrgInData: unknown;
    repo.useMiddleware(async ({ context, next }) => {
      const result = await next();
      observedOrgInData = context.data?.organizationId;
      return result;
    });

    // Tenant resolved via options — multi-tenant plugin's before:create
    // hook stamps `context.data.organizationId` BEFORE middleware's
    // `next()` returns. Middleware then sees the stamped value.
    await repo.create({ name: 'A' } as Partial<IDoc>, { organizationId: 'org-a' });
    expect(observedOrgInData).toBe('org-a');
  });

  it('does NOT fire when a before-hook throws (build-phase precedes middleware dispatch)', async () => {
    // Documented architectural boundary: middleware wraps the run-phase
    // (the actual op + after/error hooks). The build-phase (context
    // construction + before:* hooks) executes BEFORE middleware
    // composes — so a `before:create` throw never reaches middleware.
    // Plugins that need to short-circuit on policy violations (multi-
    // tenant required, validation chain) keep their authority intact.
    const repo = new Repository<IDoc>(Model, [
      multiTenantPlugin({ tenantField: 'organizationId', required: true }),
    ]);

    let nextCalled = false;
    repo.useMiddleware(async ({ next }) => {
      nextCalled = true;
      return next();
    });

    await expect(
      repo.create({ name: 'B' } as Partial<IDoc>),
    ).rejects.toThrow(/Missing 'organizationId'/);
    expect(nextCalled).toBe(false); // throw came from before-hook, never reached middleware
  });

  it('returns `this` from useMiddleware for chaining', () => {
    const repo = new Repository<IDoc>(Model);
    const noop: Middleware<IDoc> = ({ next }) => next();
    expect(repo.useMiddleware(noop)).toBe(repo);
  });

  it('fires for cached reads — getById / getOne / getAll cache-hit paths', async () => {
    // Pre-fix: getOne / getAll cache-hit branches returned BEFORE the
    // middleware composition, so wrap-style middleware silently missed
    // every cached read. Fix wraps the cache-hit emit + return inside
    // `_composeMiddleware` so timing / audit / transformer middleware
    // sees cached operations identically to DB-backed ones.
    const { cachePlugin } = await import('../../src/plugins/cache.plugin.js');
    const { createMemoryCache } = await import('../../src/utils/memory-cache.js');

    const repo = new Repository<IDoc>(Model, [
      cachePlugin({ adapter: createMemoryCache(), defaults: { staleTime: 60 } }),
    ]);

    const created = await repo.create({ organizationId: 'org-a', name: 'A' });

    const seen: string[] = [];
    repo.useMiddleware(async ({ operation, next }) => {
      seen.push(`mw:${operation}`);
      return next();
    });

    // Prime caches.
    await repo.getById(String(created._id));
    await repo.getOne({ _id: created._id });
    await repo.getAll({ page: 1, limit: 10 });

    // Reset and re-run — every call below should be a cache hit AND
    // every one must fire middleware. Pre-fix this would only show
    // mw:getById (the one path already wrapped); getOne / getAll hits
    // would be missing.
    seen.length = 0;
    await repo.getById(String(created._id));
    await repo.getOne({ _id: created._id });
    await repo.getAll({ page: 1, limit: 10 });

    expect(seen).toEqual(['mw:getById', 'mw:getOne', 'mw:getAll']);
  });
});
