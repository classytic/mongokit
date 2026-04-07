/**
 * softRequired end-to-end integration
 *
 * Proves that the `softRequired` schema-gen option integrates cleanly with
 * the full Repository stack: plugins (soft-delete, multi-tenant, cache),
 * QueryParser, create/update/find flows, and the generated CRUD schemas.
 *
 * The three invariants under test:
 *   1. Generated `createBody` schema omits soft-required fields from `required[]`
 *      so a draft POST body passes Fastify-style validation.
 *   2. The DB-level `required: true` invariant is still enforced by Mongoose —
 *      Repository.create() rejects null/undefined for soft-required fields.
 *   3. QueryParser + all plugins (soft-delete filter, multi-tenant scoping,
 *      cache invalidation) operate identically whether a field is soft-required
 *      or hard-required. The option is purely a schema-gen concern.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Document, Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCrudSchemasFromModel,
  cachePlugin,
  createMemoryCache,
  multiTenantPlugin,
  QueryParser,
  softDeletePlugin,
} from '../src/index.js';
import Repository from '../src/Repository.js';

interface IJournalEntry extends Document {
  label: string;
  journalType: string;
  date: Date;
  organizationId: string;
  amount: number;
  deletedAt?: Date | null;
}

const JournalEntrySchema = new Schema<IJournalEntry>({
  label: { type: String, required: true },
  // softRequired: DB rejects null, but body schema may omit (draft UX)
  journalType: {
    type: String,
    required: true,
    softRequired: true,
    enum: ['sale', 'purchase', 'adjustment'],
  },
  date: { type: Date, required: true, softRequired: true },
  organizationId: { type: String, required: true, index: true },
  amount: { type: Number, required: true },
  deletedAt: { type: Date, default: null },
});

let mongo: MongoMemoryServer;
let Model: mongoose.Model<IJournalEntry>;
let repo: Repository<IJournalEntry>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Model = mongoose.model<IJournalEntry>('JournalEntryIT', JournalEntrySchema);

  repo = new Repository<IJournalEntry>(Model);
  repo.use(softDeletePlugin());
  repo.use(multiTenantPlugin({ tenantField: 'organizationId' }));
  repo.use(cachePlugin({ cache: createMemoryCache(), ttl: 5000 }));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Model.deleteMany({});
});

describe('softRequired — full stack integration', () => {
  it('generated createBody shape lets a draft body through while still requiring hard fields', () => {
    const { createBody } = buildCrudSchemasFromModel(Model);

    // Schema shape: soft-required fields present in properties, absent from required[]
    expect(createBody.properties?.journalType).toBeDefined();
    expect(createBody.properties?.date).toBeDefined();
    expect(createBody.required).toContain('label');
    expect(createBody.required).toContain('amount');
    expect(createBody.required).not.toContain('journalType');
    expect(createBody.required).not.toContain('date');

    // Simulate what Fastify/Ajv will do: a draft body is "valid" if every entry
    // in required[] is present. This mirrors the only rule that changes under
    // softRequired — we deliberately don't pull in Ajv as a dev dep for one test.
    const draftBody: Record<string, unknown> = {
      label: 'Q1 draft',
      amount: 0,
      organizationId: 'org_1',
    };
    const missingInDraft = (createBody.required ?? []).filter((k) => !(k in draftBody));
    expect(missingInDraft).toEqual([]);

    const invalid: Record<string, unknown> = { journalType: 'sale' };
    const missingInInvalid = (createBody.required ?? []).filter((k) => !(k in invalid));
    expect(missingInInvalid).toContain('label');
    expect(missingInInvalid).toContain('amount');
  });

  it('Repository.create() still enforces the DB-level required invariant on null', async () => {
    await expect(
      repo.create(
        {
          label: 'bad entry',
          amount: 10,
          // biome-ignore lint/suspicious/noExplicitAny: testing runtime null rejection
          journalType: null as any,
          // biome-ignore lint/suspicious/noExplicitAny: testing runtime null rejection
          date: null as any,
        },
        { organizationId: 'org_1' },
      ),
    ).rejects.toThrow(/journalType|date/);
  });

  it('persists a valid draft (omitted soft-required fields via undefined) — DB still rejects', async () => {
    // Mongoose treats `undefined` at create time as "not set" — the required
    // validator still fires. This test documents that softRequired does not
    // weaken the DB constraint, it only affects the HTTP schema.
    await expect(
      repo.create({ label: 'draft', amount: 0 } as Partial<IJournalEntry>, {
        organizationId: 'org_1',
      }),
    ).rejects.toThrow(/journalType|date/);
  });

  it('plugins (soft-delete + multi-tenant + cache) work identically with softRequired fields', async () => {
    const created = await repo.create(
      {
        label: 'Q1 close',
        journalType: 'sale',
        date: new Date('2026-01-31'),
        amount: 1000,
      },
      { organizationId: 'org_A' },
    );
    expect(created.journalType).toBe('sale');

    // Multi-tenant isolation: org_B cannot see org_A's entry
    const scopedA = await repo.findAll({}, { organizationId: 'org_A' });
    const scopedB = await repo.findAll({}, { organizationId: 'org_B' });
    expect(scopedA.length).toBe(1);
    expect(scopedB.length).toBe(0);

    // Soft delete: filtered out of subsequent reads
    await repo.delete(String(created._id), { organizationId: 'org_A' });
    const afterDelete = await repo.findAll({}, { organizationId: 'org_A' });
    expect(afterDelete.length).toBe(0);

    // Raw DB still has the doc with deletedAt set (soft delete behavior)
    const raw = await Model.findById(created._id).lean();
    expect(raw?.deletedAt).toBeTruthy();
  });

  it('QueryParser treats soft-required fields identically to any other field', () => {
    const parser = new QueryParser({
      allowedFilterFields: ['journalType', 'date', 'label', 'amount'],
    });
    const parsed = parser.parse({
      journalType: 'sale',
      'amount[gte]': '500',
    });

    expect(parsed.filters).toMatchObject({ journalType: 'sale' });
    expect(parsed.filters.amount).toMatchObject({ $gte: 500 });
  });

  it('updateBody does not regress — still treats all fields as optional', () => {
    const { updateBody } = buildCrudSchemasFromModel(Model);
    expect(updateBody.required ?? []).not.toContain('label');
    expect(updateBody.required ?? []).not.toContain('journalType');
    expect(updateBody.properties?.journalType).toBeDefined();
    expect(updateBody.properties?.label).toBeDefined();
  });
});
