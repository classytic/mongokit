import { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { QueryParser } from '../src/index.js';

interface IReleaseDoc {
  releasedAt: Date;
}

const ReleaseSchema = new Schema<IReleaseDoc>({
  releasedAt: { type: Date, required: true },
});

describe('Review validation - QueryParser schema-aware date operators', () => {
  it('coerces gte/lte values to Date for Date fields when schema is provided', () => {
    const parser = new QueryParser({ schema: ReleaseSchema });

    const parsed = parser.parse({
      'releasedAt[gte]': '2026-04-01',
      'releasedAt[lte]': '2026-04-30',
    });

    expect(parsed.filters.releasedAt).toEqual({
      $gte: new Date('2026-04-01T00:00:00.000Z'),
      $lte: new Date('2026-04-30T00:00:00.000Z'),
    });
  });
});
