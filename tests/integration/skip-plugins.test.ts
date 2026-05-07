/**
 * `skipPlugins: string[]` per-call escape hatch.
 *
 * Hot paths (heartbeats, counter writes) shouldn't pay audit / metric
 * overhead on every call. Pass `skipPlugins: ['auditLog']` (or
 * `'auditTrail'` / `'observability'`) to opt the listed plugins out
 * for that call only.
 *
 * Security/correctness plugins (multi-tenant, cache invalidation,
 * soft-delete) deliberately do NOT honor `skipPlugins` — those must
 * always run.
 */

import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../../src/index.js';
import { auditLogPlugin } from '../../src/plugins/audit-log.plugin.js';
import { multiTenantPlugin } from '../../src/plugins/multi-tenant.plugin.js';
import { observabilityPlugin } from '../../src/plugins/observability.plugin.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRun {
  _id?: mongoose.Types.ObjectId;
  organizationId: string;
  status: string;
  heartbeatAt?: Date;
}

describe('skipPlugins per-call opt-out', () => {
  let Model: mongoose.Model<IRun>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'SkipPluginsRun',
      new Schema<IRun>({
        organizationId: { type: String, required: true, index: true },
        status: { type: String, required: true },
        heartbeatAt: { type: Date },
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

  it('skipPlugins: ["auditLog"] silences audit-log for that call only', async () => {
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const repo = new Repository<IRun>(Model, [auditLogPlugin(logger)]);

    // No skip → audit-log fires.
    await repo.create({ organizationId: 'org-a', status: 'queued' });
    expect(logger.info).toHaveBeenCalledTimes(1);

    logger.info.mockClear();
    // With skip → audit-log silent.
    await repo.create(
      { organizationId: 'org-a', status: 'running' },
      { skipPlugins: ['auditLog'] },
    );
    expect(logger.info).toHaveBeenCalledTimes(0);

    // Skip is per-call — next call without skip resumes logging.
    await repo.create({ organizationId: 'org-a', status: 'done' });
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('skipPlugins: ["observability"] suppresses metric emission', async () => {
    const onMetric = vi.fn();
    const repo = new Repository<IRun>(Model, [
      observabilityPlugin({ onMetric, operations: ['create'] }),
    ]);

    await repo.create({ organizationId: 'org-a', status: 'queued' });
    expect(onMetric).toHaveBeenCalledTimes(1);

    onMetric.mockClear();
    await repo.create(
      { organizationId: 'org-a', status: 'running' },
      { skipPlugins: ['observability'] },
    );
    expect(onMetric).toHaveBeenCalledTimes(0);
  });

  it('multi-tenant scope is NOT skippable (security/correctness)', async () => {
    const repo = new Repository<IRun>(Model, [
      multiTenantPlugin({ tenantField: 'organizationId', required: true }),
    ]);

    // skipPlugins includes 'multi-tenant' — this MUST still throw because
    // the multi-tenant plugin deliberately ignores skipPlugins.
    await expect(
      repo.create(
        { status: 'queued' } as Partial<IRun>,
        { skipPlugins: ['multi-tenant'] } as never,
      ),
    ).rejects.toThrow(/Missing 'organizationId'/);
  });

  it('skipping multiple plugins at once works', async () => {
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const onMetric = vi.fn();
    const repo = new Repository<IRun>(Model, [
      auditLogPlugin(logger),
      observabilityPlugin({ onMetric, operations: ['create'] }),
    ]);

    await repo.create(
      { organizationId: 'org-a', status: 'heartbeat' },
      { skipPlugins: ['auditLog', 'observability'] },
    );
    expect(logger.info).toHaveBeenCalledTimes(0);
    expect(onMetric).toHaveBeenCalledTimes(0);
  });
});
