import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryParser, Repository } from '../src/index.js';
import { connectDB, disconnectDB } from './setup.js';

interface IInventoryItem {
  _id: Types.ObjectId;
  name: string;
  stock: number;
  status: 'active' | 'archived';
}

const InventorySchema = new Schema<IInventoryItem>({
  name: { type: String, required: true },
  stock: { type: Number, required: true },
  status: { type: String, enum: ['active', 'archived'], required: true },
});

describe('Review validation - QueryParser gaps', () => {
  describe('dangerous $or sanitization', () => {
    it('drops dangerous-only URL or branches instead of leaving a match-all {} branch', () => {
      // drop mode: this pins the branch-collapse machinery (default 'throw'
      // 400s at the first dangerous key — queryParser.invalidInput.test.ts)
      const parser = new QueryParser({ invalidInput: 'drop' });

      const parsed = parser.parse({
        or: [{ $where: 'this.secret === true' }, { status: 'active' }],
      });

      expect(parsed.filters.$or).toEqual([{ status: 'active' }]);
    });

    it('drops dangerous-only aggregation $or branches instead of widening the match', () => {
      const parser = new QueryParser({ invalidInput: 'drop', enableAggregations: true });

      const parsed = parser.parse({
        aggregate: {
          match: {
            $or: [{ $where: 'this.secret === true' }, { status: 'active' }],
          },
        },
      });

      expect(parsed.aggregation).toEqual([
        {
          $match: {
            $or: [{ status: 'active' }],
          },
        },
      ]);
    });
  });

  describe('direct equality DX', () => {
    let ItemModel: mongoose.Model<IInventoryItem>;
    let repo: Repository<IInventoryItem>;

    beforeAll(async () => {
      await connectDB();
      if (mongoose.models.InventoryReviewItem) {
        delete mongoose.models.InventoryReviewItem;
      }
      ItemModel = mongoose.model<IInventoryItem>('InventoryReviewItem', InventorySchema);
      await ItemModel.init();
      repo = new Repository(ItemModel);
    });

    afterAll(async () => {
      await disconnectDB();
    });

    beforeEach(async () => {
      await ItemModel.deleteMany({});
      await ItemModel.create([
        { name: 'low stock', stock: 5, status: 'active' },
        { name: 'full stock', stock: 50, status: 'active' },
      ]);
    });

    it('coerces direct numeric equality so parser output works against numeric fields', async () => {
      const parser = new QueryParser();
      const parsed = parser.parse({ stock: '50' });

      expect(parsed.filters.stock).toBe(50);

      const result = await repo.getAll({
        filters: parsed.filters,
        mode: 'offset',
        limit: 10,
      });

      expect(result.method).toBe('offset');
      if (result.method === 'offset') {
        expect(result.total).toBe(1);
        expect(result.data).toHaveLength(1);
        expect((result.data[0] as IInventoryItem).name).toBe('full stock');
      }
    });
  });
});
