/**
 * `buildKeysetFilter` — the position predicate must COMPOSE with the caller's
 * filter, take each field's operator from that field's own direction, and
 * handle a null cursor value rather than emit a predicate that matches nothing.
 *
 * Pure — no mongo. The integration half (`keyset-mixed-direction.test.ts`)
 * proves the walk; this half pins the shapes so a regression reads as a diff,
 * not a missing row.
 */

import { describe, expect, it } from 'vitest';
import { buildKeysetFilter } from '../../src/pagination/utils/filter.js';

const ID = '66d000000000000000000001';

describe('the caller filter survives onto page 2', () => {
  it("does not replace the caller's own $or with the position $or", () => {
    // Page 1 honoured `status in (active, review)`. Page 2 used to widen to
    // every status, because `{ ...base, $or: position }` overwrote it.
    const base = { $or: [{ status: 'active' }, { status: 'review' }], tenantId: 't1' };
    const filter = buildKeysetFilter(base, { createdAt: -1, _id: -1 }, new Date(0), ID);

    expect(filter).toEqual({
      $and: [base, { $or: expect.any(Array) }],
    });
    expect(JSON.stringify(filter)).toContain('"status":"review"');
  });

  it("does not replace the caller's _id filter when paging by _id", () => {
    const base = { _id: { $in: [ID] } };
    const filter = buildKeysetFilter(base, { _id: 1 }, undefined, ID);

    expect(filter).toEqual({ $and: [base, { _id: { $gt: ID } }] });
  });

  it("does not replace the caller's filter on the sort field itself (desc-null tie)", () => {
    // The descending-null branch emits `{ field: null, _id: {...} }` — a flat
    // spread would have overwritten a caller's own `field` predicate.
    const base = { score: { $gte: 0 } };
    const filter = buildKeysetFilter(base, { score: -1, _id: -1 }, null, ID);

    expect(filter).toEqual({ $and: [base, { score: null, _id: { $lt: ID } }] });
  });

  it('stays FLAT when nothing collides — the shape every explain plan was written against', () => {
    const filter = buildKeysetFilter({ status: 'active' }, { createdAt: -1, _id: -1 }, 5, ID);

    expect(filter).toEqual({
      status: 'active',
      // desc + typed: the nulls sort AFTER every typed value, so they are "after 5" too
      $or: [{ createdAt: { $lt: 5 } }, { createdAt: null }, { createdAt: 5, _id: { $lt: ID } }],
    });
  });
});

describe('each field takes the operator from ITS OWN direction', () => {
  it('mixed-direction compound: priority asc, createdAt desc, _id desc', () => {
    const filter = buildKeysetFilter({}, { priority: 1, createdAt: -1, _id: -1 }, 3, ID, {
      priority: 3,
      createdAt: 100,
    });

    expect(filter).toEqual({
      $or: [
        { priority: { $gt: 3 } },
        { priority: 3, createdAt: { $lt: 100 } },
        { priority: 3, createdAt: null },
        { priority: 3, createdAt: 100, _id: { $lt: ID } },
      ],
    });
  });

  it('single field asc with _id desc: the tiebreaker follows _id, not the field', () => {
    const filter = buildKeysetFilter({}, { score: 1, _id: -1 }, 7, ID);

    expect(filter).toEqual({
      $or: [{ score: { $gt: 7 } }, { score: 7, _id: { $lt: ID } }],
    });
  });
});

describe('a null cursor value is a boundary, not a predicate that matches nothing', () => {
  it('compound ascending: everything typed comes after null', () => {
    const filter = buildKeysetFilter({}, { a: 1, b: 1, _id: 1 }, 1, ID, { a: 1, b: null });

    expect(filter).toEqual({
      $or: [{ a: { $gt: 1 } }, { a: 1, b: { $ne: null } }, { a: 1, b: null, _id: { $gt: ID } }],
    });
  });

  it('compound descending: nothing comes after null, so that branch is dropped', () => {
    // `{ b: { $lt: null } }` matches NO document in BSON order. Emitting it was
    // harmless only by accident; dropping it says what is meant.
    const filter = buildKeysetFilter({}, { a: -1, b: -1, _id: -1 }, 1, ID, { a: 1, b: null });

    expect(filter).toEqual({
      $or: [{ a: { $lt: 1 } }, { a: null }, { a: 1, b: null, _id: { $lt: ID } }],
    });
  });

  it('descending + TYPED cursor value still reaches the nulls that sort after it', () => {
    // The integration walk lost every `rank: null` row under `{ rank: -1 }`:
    // `{ $lt: 0 }` does not match null, and nulls sort LAST in descending
    // order, so the walk ended at the last typed value with hasMore: false.
    const filter = buildKeysetFilter({}, { rank: -1, _id: -1 }, 0, ID);

    expect(filter).toEqual({
      $or: [{ rank: { $lt: 0 } }, { rank: null }, { rank: 0, _id: { $lt: ID } }],
    });
  });

  it('never emits $gt: null or $lt: null anywhere', () => {
    const cases = [
      buildKeysetFilter({}, { a: 1, _id: 1 }, null, ID),
      buildKeysetFilter({}, { a: -1, _id: -1 }, null, ID),
      buildKeysetFilter({}, { a: 1, b: -1, _id: -1 }, null, ID, { a: null, b: null }),
    ];
    for (const filter of cases) {
      const s = JSON.stringify(filter);
      expect(s).not.toContain('"$gt":null');
      expect(s).not.toContain('"$lt":null');
    }
  });
});
