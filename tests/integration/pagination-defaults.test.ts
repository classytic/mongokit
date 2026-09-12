/**
 * `PaginationConfig.defaultCountStrategy` / `defaultMode` — pagination policy
 * set once on the repository instead of per call. Defaults unchanged when
 * unset; a per-call value always wins.
 */

import type {
  KeysetPaginationResult,
  OffsetPaginationResult,
} from '@classytic/repo-core/pagination';
import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IDoc {
  name: string;
  bucket: number;
  createdAt?: Date;
}

const TOTAL = 15;

describe('PaginationConfig defaults', () => {
  let Model: mongoose.Model<IDoc>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'PaginationDefaultsDoc',
      new Schema<IDoc>(
        {
          name: { type: String, required: true },
          bucket: { type: Number, required: true },
        },
        { timestamps: true },
      ),
    );
    await Model.deleteMany({});
    await Model.insertMany(
      Array.from({ length: TOTAL }, (_, i) => ({ name: `doc-${i}`, bucket: i % 2 })),
    );
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('defaultCountStrategy', () => {
    it("'none' issues no count query and still reports hasNext correctly", async () => {
      const repo = new Repository<IDoc>(Model, [], { defaultCountStrategy: 'none' });
      const countSpy = vi.spyOn(Model, 'countDocuments');
      const estimateSpy = vi.spyOn(Model, 'estimatedDocumentCount');

      const first = (await repo.getAll({ limit: 10 })) as OffsetPaginationResult<IDoc>;
      expect(first.method).toBe('offset');
      expect(first.data).toHaveLength(10);
      expect(first.hasNext).toBe(true);
      expect(first.total).toBe(0);

      const second = (await repo.getAll({ page: 2, limit: 10 })) as OffsetPaginationResult<IDoc>;
      expect(second.data).toHaveLength(5);
      expect(second.hasNext).toBe(false);

      expect(countSpy).not.toHaveBeenCalled();
      expect(estimateSpy).not.toHaveBeenCalled();
    });

    it('a per-call countStrategy still wins over the repo default', async () => {
      const repo = new Repository<IDoc>(Model, [], { defaultCountStrategy: 'none' });
      const countSpy = vi.spyOn(Model, 'countDocuments');

      const result = (await repo.getAll({
        limit: 10,
        countStrategy: 'exact',
      })) as OffsetPaginationResult<IDoc>;
      expect(result.total).toBe(TOTAL);
      expect(result.hasNext).toBe(true);
      expect(countSpy).toHaveBeenCalledTimes(1);
    });

    it('is exact when unset — the pre-existing behaviour', async () => {
      const repo = new Repository<IDoc>(Model);
      const countSpy = vi.spyOn(Model, 'countDocuments');

      const result = (await repo.getAll({ limit: 10 })) as OffsetPaginationResult<IDoc>;
      expect(result.total).toBe(TOTAL);
      expect(result.pages).toBe(2);
      expect(countSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('defaultMode', () => {
    it("'keyset' turns a plain getAll({ filters }) into a cursor page", async () => {
      const repo = new Repository<IDoc>(Model, [], { defaultMode: 'keyset' });
      const countSpy = vi.spyOn(Model, 'countDocuments');

      const first = (await repo.getAll({ filters: { bucket: 0 }, limit: 5 })) as KeysetPaginationResult<IDoc>;
      expect(first.method).toBe('keyset');
      expect(first.data).toHaveLength(5);
      expect(first.hasMore).toBe(true);
      expect(first.next).toBeTruthy();
      expect(countSpy).not.toHaveBeenCalled();

      // The cursor round-trips through the same default.
      const rest = (await repo.getAll({
        filters: { bucket: 0 },
        limit: 5,
        after: first.next as string,
      })) as KeysetPaginationResult<IDoc>;
      expect(rest.method).toBe('keyset');
      expect(rest.data).toHaveLength(3);
      expect(rest.hasMore).toBe(false);
    });

    it('an explicit page still selects offset under a keyset default', async () => {
      const repo = new Repository<IDoc>(Model, [], { defaultMode: 'keyset' });
      const result = (await repo.getAll({ page: 2, limit: 10 })) as OffsetPaginationResult<IDoc>;
      expect(result.method).toBe('offset');
      expect(result.page).toBe(2);
      expect(result.data).toHaveLength(5);
    });

    it("an explicit mode: 'offset' still wins over a keyset default", async () => {
      const repo = new Repository<IDoc>(Model, [], { defaultMode: 'keyset' });
      const result = (await repo.getAll({ mode: 'offset', limit: 10 })) as OffsetPaginationResult<IDoc>;
      expect(result.method).toBe('offset');
    });

    it('unset keeps the sort-based auto-detection', async () => {
      const repo = new Repository<IDoc>(Model);
      const plain = (await repo.getAll({ limit: 10 })) as OffsetPaginationResult<IDoc>;
      expect(plain.method).toBe('offset');
      const sorted = (await repo.getAll({ sort: 'name', limit: 10 })) as KeysetPaginationResult<IDoc>;
      expect(sorted.method).toBe('keyset');
    });
  });
});
