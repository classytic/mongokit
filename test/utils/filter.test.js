import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { buildKeysetFilter } from '../../src/pagination/utils/filter.js';

describe('Filter Utils', () => {
  it('should build filter for ascending sort', () => {
    const baseFilters = { organizationId: '123' };
    const sort = { createdAt: 1, _id: 1 };
    const cursorValue = new Date('2024-01-15');
    const cursorId = new mongoose.Types.ObjectId();

    const filter = buildKeysetFilter(baseFilters, sort, cursorValue, cursorId);

    assert.strictEqual(filter.organizationId, '123');
    assert.ok(filter.$or);
    assert.strictEqual(filter.$or[0].createdAt.$gt, cursorValue);
    assert.strictEqual(filter.$or[1].createdAt, cursorValue);
    assert.strictEqual(filter.$or[1]._id.$gt, cursorId);
  });

  it('should build filter for descending sort', () => {
    const baseFilters = {};
    const sort = { createdAt: -1, _id: -1 };
    const cursorValue = new Date('2024-01-15');
    const cursorId = new mongoose.Types.ObjectId();

    const filter = buildKeysetFilter(baseFilters, sort, cursorValue, cursorId);

    assert.ok(filter.$or);
    assert.strictEqual(filter.$or[0].createdAt.$lt, cursorValue);
    assert.strictEqual(filter.$or[1].createdAt, cursorValue);
    assert.strictEqual(filter.$or[1]._id.$lt, cursorId);
  });

  it('should handle _id only sort', () => {
    const baseFilters = { active: true };
    const sort = { _id: 1 };
    const cursorValue = new mongoose.Types.ObjectId();
    const cursorId = new mongoose.Types.ObjectId();

    const filter = buildKeysetFilter(baseFilters, sort, cursorValue, cursorId);

    assert.strictEqual(filter.active, true);
    assert.ok(filter.$or);
  });

  it('should preserve all base filters', () => {
    const baseFilters = {
      organizationId: '123',
      status: 'active',
      type: 'user'
    };
    const sort = { name: 1, _id: 1 };
    const cursorValue = 'Alice';
    const cursorId = new mongoose.Types.ObjectId();

    const filter = buildKeysetFilter(baseFilters, sort, cursorValue, cursorId);

    assert.strictEqual(filter.organizationId, '123');
    assert.strictEqual(filter.status, 'active');
    assert.strictEqual(filter.type, 'user');
    assert.ok(filter.$or);
  });
});
