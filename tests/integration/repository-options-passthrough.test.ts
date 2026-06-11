/**
 * Repository options passthrough — `schema` / `updateSchema` / `events`
 * forwarded to repo-core's `RepositoryBase` (0.6.0 contract).
 *
 * The Standard Schema here is hand-built (a plain object with the
 * `'~standard'` marker) — no zod/valibot dependency — proving that ANY
 * conforming validator slots in. The event transport is an in-memory
 * collector matching `RepositoryEventPublisher` structurally.
 */

import type { DomainEvent } from '@classytic/repo-core/events';
import type { StandardSchemaV1 } from '@classytic/repo-core/schema';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IValidated {
  name: string;
  email?: string;
}

/** Hand-built Standard Schema: requires a non-empty string `name`. */
const createSchema: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'mongokit-tests',
    validate(value: unknown) {
      const v = value as Record<string, unknown> | null;
      if (!v || typeof v.name !== 'string' || v.name.length === 0) {
        return { issues: [{ message: 'name must be a non-empty string', path: ['name'] }] };
      }
      // Coercion check: validator output replaces the payload.
      return { value: { ...v, name: (v.name as string).trim() } };
    },
  },
};

describe('Repository options passthrough (schema / events → RepositoryBase)', () => {
  let Model: mongoose.Model<IValidated>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'OptionsPassthroughDoc',
      new mongoose.Schema<IValidated>({
        name: { type: String, required: true },
        email: { type: String },
      }),
    );
  });

  beforeEach(async () => {
    await Model.deleteMany({});
  });

  afterAll(async () => {
    if (Model) await Model.deleteMany({});
    await disconnectDB();
  });

  it('rejects an invalid create with status 400 via a hand-built Standard Schema', async () => {
    const repo = new Repository<IValidated>(Model, [], {}, { schema: createSchema });

    const err = await repo
      .create({ email: 'no-name@example.com' })
      .then(() => null)
      .catch((e: Error & { status?: number; validationErrors?: unknown }) => e);

    expect(err).not.toBeNull();
    expect(err?.status).toBe(400);
    // No document landed.
    expect(await Model.countDocuments({})).toBe(0);
  });

  it('applies validator output (coercions) to the write', async () => {
    const repo = new Repository<IValidated>(Model, [], {}, { schema: createSchema });
    const doc = await repo.create({ name: '  padded  ' });
    expect(doc.name).toBe('padded'); // schema's trim flowed into the write
  });

  it('publishes <model>.created through the events transport after create', async () => {
    const received: DomainEvent[] = [];
    const transport = {
      name: 'memory-collector',
      publish: async (event: DomainEvent) => {
        received.push(event);
      },
    };

    const repo = new Repository<IValidated>(Model, [], {}, { events: { transport } });
    const doc = await repo.create({ name: 'evented' });

    // Default hook mode is 'async' (awaited), so the event has been
    // published by the time create() resolves.
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe(`${Model.modelName.toLowerCase()}.created`);
    expect(received[0].meta.resource).toBe(Model.modelName.toLowerCase());
    expect(String(received[0].meta.resourceId)).toBe(
      String((doc as IValidated & { _id: unknown })._id),
    );
    expect((received[0].payload as IValidated).name).toBe('evented');
  });
});
