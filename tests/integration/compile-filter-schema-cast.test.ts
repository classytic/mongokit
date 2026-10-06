/**
 * `compileFilterToMongo(filter, schema)` casts operands to their column types for a `$match`.
 * A materialized aggregation receives arc's tenant scope as a STRING id; against an ObjectId
 * column it matched nothing — every row-level pipeline answered `rows: []` with no error.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileFilterToMongo, Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IOrd {
  organizationId: mongoose.Types.ObjectId;
  amount: number;
  createdAt: Date;
}

describe('compileFilterToMongo with a schema — a $match over typed columns', () => {
  let Model: mongoose.Model<IOrd>;
  let repo: Repository<IOrd>;
  const org = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await connectDB();
    const schema = new Schema<IOrd>({
      organizationId: { type: Schema.Types.ObjectId, required: true },
      amount: { type: Number, required: true },
      createdAt: { type: Date, required: true },
    });
    Model = await createTestModel('CompileSchemaCastOrd', schema);
    repo = new Repository(Model);
    await Model.create({ organizationId: org, amount: 5, createdAt: new Date() });
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  const scoped = () => ({
    organizationId: org.toHexString(),
    createdAt: { $gte: new Date(Date.now() - 86_400_000).toISOString() },
  });

  it('casts the string tenant id, so the pipeline finds the row', async () => {
    const rows = await repo.aggregatePipeline([{ $match: compileFilterToMongo(scoped(), Model.schema) }]);
    expect(rows).toHaveLength(1);
  });

  it('without the schema the same filter matches nothing — why callers must pass it', async () => {
    const rows = await repo.aggregatePipeline([{ $match: compileFilterToMongo(scoped()) }]);
    expect(rows).toHaveLength(0);
  });
});
