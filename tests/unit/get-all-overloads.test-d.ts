/**
 * Compile-time assertion: an explicit `mode` / `noPagination` decides `getAll`'s result type, so a
 * caller never casts the three-way union down to the envelope it asked for.
 */

import type { Document, Types } from 'mongoose';
import type { Repository } from '../../src/Repository.js';
import type { KeysetPaginationResult, OffsetPaginationResult } from '@classytic/repo-core/pagination';

interface Row extends Document {
  _id: Types.ObjectId;
  name: string;
}

declare const repo: Repository<Row>;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>(_: T) => {};

async function overloads() {
  const offset = await repo.getAll({ mode: 'offset', page: 1, limit: 20 });
  assert<Equal<typeof offset, OffsetPaginationResult<Row>>>(true);
  offset.total satisfies number;

  const keyset = await repo.getAll({ mode: 'keyset', limit: 20 });
  assert<Equal<typeof keyset, KeysetPaginationResult<Row>>>(true);

  const all = await repo.getAll({ noPagination: true });
  assert<Equal<typeof all, Row[]>>(true);

  // No explicit mode: the envelope depends on runtime detection, so the union stays.
  const detected = await repo.getAll({ page: 1 });
  assert<Equal<typeof detected, OffsetPaginationResult<Row> | KeysetPaginationResult<Row> | Row[]>>(true);
}
void overloads;
