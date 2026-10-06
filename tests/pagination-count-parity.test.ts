/**
 * The page and its count describe the SAME result set, and never race inside a transaction:
 *   - a collation reaches the count as well as the rows;
 *   - under a session, the count starts only after the find has finished (MongoDB forbids two
 *     operations in one transaction at once); without one they may still overlap.
 * Real replica set.
 */

import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface IPerson {
  _id: Types.ObjectId;
  name: string;
}

const events: string[] = [];
const PersonSchema = new Schema<IPerson>({ name: { type: String, required: true } });
PersonSchema.pre('find', () => void events.push('find:start'));
PersonSchema.post('find', () => void events.push('find:end'));
PersonSchema.pre('countDocuments', () => void events.push('count:start'));

describe('pagination — rows and count agree', () => {
  let Person: mongoose.Model<IPerson>;
  let repo: Repository<IPerson>;

  beforeAll(async () => {
    await connectDB();
    Person = await createTestModel('PageParityPerson', PersonSchema);
    repo = new Repository(Person);
  });
  afterAll(async () => {
    await disconnectDB();
  });
  beforeEach(async () => {
    await Person.deleteMany({});
    await Person.insertMany([
      { name: 'Alice' },
      { name: 'alice' },
      { name: 'ALICE' },
      { name: 'bob' },
    ]);
    events.length = 0;
  });

  it.each(['exact', 'capped'] as const)(
    'a collation reaches the %s count, not just the rows',
    async (countStrategy) => {
      const page = await repo.getAll({
        mode: 'offset',
        page: 1,
        limit: 10,
        filters: { name: 'alice' },
        collation: { locale: 'en', strength: 2 },
        countStrategy,
      });
      expect(page.data).toHaveLength(3);
      expect(page.total).toBe(3);
    },
  );

  it('inside a transaction the count starts only after the find has finished', async () => {
    await repo.withTransaction(async (tx) => {
      const page = await tx.getAll({ mode: 'offset', page: 1, limit: 2, filters: {} });
      expect(page.total).toBe(4);
    });
    expect(events.indexOf('count:start')).toBeGreaterThan(events.indexOf('find:end'));
  });
});
