import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { elasticSearchPlugin } from '../src/plugins/elastic.plugin.js';
import { methodRegistryPlugin } from '../src/plugins/method-registry.plugin.js';
import { Repository } from '../src/Repository.js';

describe('elasticSearchPlugin', () => {
  let MockModel: any;
  let mockEsClient: any;
  const data = [
    { _id: new mongoose.Types.ObjectId(), name: 'Alpha', order: 1 },
    { _id: new mongoose.Types.ObjectId(), name: 'Beta', order: 2 },
    { _id: new mongoose.Types.ObjectId(), name: 'Gamma', order: 3 },
  ];

  beforeEach(() => {
    mockEsClient = {
      search: vi.fn(),
    };

    MockModel = {
      find: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      populate: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn(),
    };
  });

  it('throws error if methodRegistryPlugin is not present', () => {
    expect(
      () =>
        new Repository(MockModel as any, [
          elasticSearchPlugin({ client: mockEsClient, index: 'test' }),
        ]),
    ).toThrow(/requires methodRegistryPlugin/);
  });

  it('searches and maps es results back to mongo docs preserving order', async () => {
    mockEsClient.search.mockResolvedValue({
      hits: {
        total: { value: 3 },
        hits: [
          { _id: String(data[2]._id), _score: 2.5 }, // Gamma is highest
          { _id: String(data[0]._id), _score: 1.2 }, // Alpha is second
          { _id: String(data[1]._id), _score: 0.1 }, // Beta is last
        ],
      },
    });

    // Unordered fetch from mongo
    MockModel.exec.mockResolvedValue([data[0], data[1], data[2]]);

    const repo = new Repository(MockModel as any, [
      methodRegistryPlugin(),
      elasticSearchPlugin({ client: mockEsClient, index: 'test' }),
    ]);

    const result = await (repo as any).search({ match: { name: 'test' } });

    expect(mockEsClient.search).toHaveBeenCalledWith({
      index: 'test',
      body: {
        query: { match: { name: 'test' } },
        size: 20,
        from: 0,
      },
    });

    expect(MockModel.find).toHaveBeenCalledWith({
      _id: {
        $in: [String(data[2]._id), String(data[0]._id), String(data[1]._id)],
      },
    });

    expect(result.data).toHaveLength(3);
    // Preserves ES sorting!
    expect(String(result.data[0]._id)).toBe(String(data[2]._id));
    expect(result.data[0]._score).toBe(2.5);
    expect(String(result.data[1]._id)).toBe(String(data[0]._id));
    expect(result.data[1]._score).toBe(1.2);
    expect(String(result.data[2]._id)).toBe(String(data[1]._id));
    expect(result.data[2]._score).toBe(0.1);

    expect(result.total).toBe(3);
  });

  it('preserves score 0', async () => {
    mockEsClient.search.mockResolvedValue({
      hits: {
        total: { value: 1 },
        hits: [{ _id: String(data[0]._id), _score: 0 }],
      },
    });
    MockModel.exec.mockResolvedValue([data[0]]);

    const repo = new Repository(MockModel as any, [
      methodRegistryPlugin(),
      elasticSearchPlugin({ client: mockEsClient, index: 'test' }),
    ]);

    const result = await (repo as any).search({ match_all: {} });
    expect(result.data[0]._score).toBe(0);
  });

  it('enforces limit boundaries', async () => {
    mockEsClient.search.mockResolvedValue({
      hits: { total: 0, hits: [] },
    });

    const repo = new Repository(MockModel as any, [
      methodRegistryPlugin(),
      elasticSearchPlugin({ client: mockEsClient, index: 'test' }),
    ]);

    await (repo as any).search({}, { limit: 9999, from: -50 });

    expect(mockEsClient.search).toHaveBeenCalledWith({
      index: 'test',
      body: expect.objectContaining({
        size: 1000, // clipped from 9999 to 1000
        from: 0, // clipped from -50 to 0
      }),
    });
  });
});
