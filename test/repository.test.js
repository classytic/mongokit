import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import mongoose from 'mongoose';
import { Repository } from '../src/index.js';

const TestSchema = new mongoose.Schema({
  name: String,
  email: String,
  status: { type: String, default: 'active' }
});

const TestModel = mongoose.model('Test', TestSchema);

class TestRepository extends Repository {
  constructor() {
    super(TestModel);
  }
}

describe('Repository', () => {
  let repo;
  let testId;

  before(async () => {
    await mongoose.connect('mongodb://localhost:27017/mongokit-test');
    repo = new TestRepository();
  });

  after(async () => {
    await TestModel.deleteMany({});
    await mongoose.disconnect();
  });

  it('should create a document', async () => {
    const doc = await repo.create({ name: 'Test User', email: 'test@example.com' });
    testId = doc._id;
    assert.ok(doc._id);
    assert.strictEqual(doc.name, 'Test User');
  });

  it('should get by id', async () => {
    const doc = await repo.getById(testId);
    assert.ok(doc);
    assert.strictEqual(doc.name, 'Test User');
  });

  it('should update a document', async () => {
    const doc = await repo.update(testId, { name: 'Updated User' });
    assert.strictEqual(doc.name, 'Updated User');
  });

  it('should count documents', async () => {
    const count = await repo.count({ status: 'active' });
    assert.ok(count > 0);
  });

  it('should delete a document', async () => {
    const doc = await repo.delete(testId);
    assert.ok(doc);
    
    const found = await repo.getById(testId, { throwOnNotFound: false });
    assert.strictEqual(found, null);
  });
});

