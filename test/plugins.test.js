import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import mongoose from 'mongoose';
import { Repository, timestampPlugin, softDeletePlugin } from '../src/index.js';

const TestSchema = new mongoose.Schema({
  name: String,
  createdAt: Date,
  updatedAt: Date,
  deletedAt: Date
});

const TestModel = mongoose.model('PluginTest', TestSchema);

describe('Plugins', () => {
  before(async () => {
    await mongoose.connect('mongodb://localhost:27017/mongokit-test');
  });

  after(async () => {
    await TestModel.deleteMany({});
    await mongoose.disconnect();
  });

  it('should apply timestamp plugin', async () => {
    class TimestampRepo extends Repository {
      constructor() {
        super(TestModel, [timestampPlugin()]);
      }
    }

    const repo = new TimestampRepo();
    const doc = await repo.create({ name: 'Timestamped' });
    
    assert.ok(doc.createdAt instanceof Date);
    assert.ok(doc.updatedAt instanceof Date);
  });

  it('should apply soft delete plugin', async () => {
    class SoftDeleteRepo extends Repository {
      constructor() {
        super(TestModel, [softDeletePlugin({ deletedField: 'deletedAt' })]);
      }
    }

    const repo = new SoftDeleteRepo();
    const doc = await repo.create({ name: 'Soft Delete Test' });
    
    // Soft delete
    await repo.delete(doc._id);
    
    // Should not be found in normal queries
    const found = await repo.getById(doc._id, { throwOnNotFound: false });
    assert.strictEqual(found, null);
  });

  it('should emit events', async (t) => {
    let eventFired = false;

    class EventRepo extends Repository {
      constructor() {
        super(TestModel);
      }
    }

    const repo = new EventRepo();
    
    repo.on('after:create', () => {
      eventFired = true;
    });

    await repo.create({ name: 'Event Test' });
    assert.ok(eventFired, 'Event should have fired');
  });
});

