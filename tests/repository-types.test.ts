/**
 * Repository Type Compatibility Tests
 *
 * Verifies that Repository accepts Mongoose models with various
 * type signatures (plain interfaces, custom methods, virtuals, etc.)
 * without requiring `as any` casts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { Repository } from '../src/index.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

// ============================================================================
// Test schemas with different type patterns
// ============================================================================

// 1. Plain interface (most common in Mongoose 9)
interface IPlainDoc {
  name: string;
  organizationId: Types.ObjectId;
  currency: string;
  description?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const PlainSchema = new Schema<IPlainDoc>({
  name: { type: String, required: true },
  organizationId: { type: Schema.Types.ObjectId, required: true },
  currency: { type: String, default: 'USD' },
  description: String,
}, { timestamps: true });

// 2. Interface with custom instance methods
interface IWithMethods {
  name: string;
  status: string;
}
interface IWithMethodsMethods {
  isActive(): boolean;
}

const WithMethodsSchema = new Schema<IWithMethods, mongoose.Model<IWithMethods, {}, IWithMethodsMethods>>({
  name: { type: String, required: true },
  status: { type: String, default: 'active' },
});
WithMethodsSchema.method('isActive', function () {
  return this.status === 'active';
});

// 3. Untyped generic (Repository without explicit generic)
const UntypedSchema = new Schema({
  title: { type: String, required: true },
  count: { type: Number, default: 0 },
});

// ============================================================================
// Tests
// ============================================================================

describe('Repository Type Compatibility', () => {
  let PlainModel: mongoose.Model<IPlainDoc>;
  let WithMethodsModel: mongoose.Model<IWithMethods, {}, IWithMethodsMethods>;
  let UntypedModel: mongoose.Model<any>;

  beforeAll(async () => {
    await connectDB();
    PlainModel = await createTestModel('PlainDoc', PlainSchema);
    WithMethodsModel = await createTestModel('WithMethods', WithMethodsSchema as any);
    UntypedModel = await createTestModel('UntypedDoc', UntypedSchema);
  });

  afterAll(async () => {
    await PlainModel.deleteMany({});
    await WithMethodsModel.deleteMany({});
    await UntypedModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await PlainModel.deleteMany({});
    await WithMethodsModel.deleteMany({});
    await UntypedModel.deleteMany({});
  });

  it('should accept a plain interface model (Mongoose 9 pattern)', async () => {
    const repo = new Repository<IPlainDoc>(PlainModel);
    const doc = await repo.create({
      name: 'Test',
      organizationId: new Types.ObjectId(),
      currency: 'EUR',
    });
    expect(doc).toBeDefined();
    expect(doc.name).toBe('Test');
    expect(doc.currency).toBe('EUR');
  });

  it('should accept a model with custom instance methods', async () => {
    const repo = new Repository<IWithMethods>(WithMethodsModel);
    const doc = await repo.create({ name: 'Test', status: 'active' });
    expect(doc).toBeDefined();
    expect(doc.name).toBe('Test');
  });

  it('should accept an untyped model (no explicit generic on Repository)', async () => {
    const repo = new Repository(UntypedModel);
    const doc = await repo.create({ title: 'Test', count: 5 });
    expect(doc).toBeDefined();
  });

  it('should work when extending Repository without a generic', async () => {
    class MyRepo extends Repository {
      constructor() {
        super(UntypedModel);
      }
    }

    const repo = new MyRepo();
    const doc = await repo.create({ title: 'Extended', count: 10 });
    expect(doc).toBeDefined();
  });

  it('should work when extending Repository with a typed generic', async () => {
    class TypedRepo extends Repository<IPlainDoc> {
      constructor() {
        super(PlainModel);
      }
    }

    const repo = new TypedRepo();
    const doc = await repo.create({
      name: 'Typed',
      organizationId: new Types.ObjectId(),
      currency: 'GBP',
    });
    expect(doc).toBeDefined();
    expect(doc.currency).toBe('GBP');
  });
});
