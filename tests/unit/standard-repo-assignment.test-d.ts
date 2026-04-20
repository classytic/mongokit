/**
 * Compile-time assertion: Repository<TDoc> assigns to StandardRepo<TDoc>
 * without casts — the 3.10.1 fix for arc BaseController TS2345.
 */
import { expectTypeOf, describe, it } from 'vitest';
import type { Document, Types } from 'mongoose';
import type { StandardRepo } from '@classytic/repo-core/repository';
import type { Repository } from '../../src/Repository.js';

interface Branch extends Document {
  _id: Types.ObjectId;
  code: string;
  name: string;
}

describe('Repository<TDoc> structural assignment to StandardRepo<TDoc>', () => {
  it('compiles without cast', () => {
    expectTypeOf<Repository<Branch>>().toMatchTypeOf<StandardRepo<Branch>>();
  });
});
