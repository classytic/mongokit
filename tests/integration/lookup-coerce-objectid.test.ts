/**
 * `LookupOptions.coerce` — joining a STRING reference to an `ObjectId` `_id`.
 *
 * ## Why this exists
 *
 * `$lookup` compares with strict BSON type equality, so a `string` holding
 * `"6a43c8fd…"` never equals `ObjectId("6a43c8fd…")`. The join simply matches
 * nothing — and a `$lookup` that matches nothing is not an error, it is an
 * empty array. The row renders without its joined data, no exception is raised,
 * and every downstream count is plausibly wrong.
 *
 * Found in production shape: `@classytic/flow` stores `skuRef` as an opaque
 * `string` (it must also admit non-ObjectId SKU codes) while
 * `catalog_products._id` is an `ObjectId`. The naive form returned 0 matches
 * for every row, so the join was abandoned and replaced by a second
 * round-trip resolver per request; three warehouse screens simply rendered raw
 * ObjectIds instead of product names.
 *
 * Each test below asserts the NAIVE form's silence alongside the coerced form's
 * match. Asserting only that `coerce` works would pass just as happily if
 * `$lookup` had started coercing on its own — the contrast is the point.
 */

import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LookupBuilder } from '../../src/query/LookupBuilder.js';
import { connectDB, disconnectDB } from '../setup.js';

interface IProduct {
  _id: Types.ObjectId;
  name: string;
}

/** The referencing side stores the id as a STRING — the whole point. */
interface IMovement {
  _id: Types.ObjectId;
  skuRef: string;
  qty: number;
}

describe('LookupOptions.coerce — string reference against ObjectId _id', () => {
  let ProductModel: mongoose.Model<IProduct>;
  let MovementModel: mongoose.Model<IMovement>;
  let productId: Types.ObjectId;

  beforeAll(async () => {
    await connectDB();
    ProductModel =
      mongoose.models.CoerceProduct ??
      mongoose.model<IProduct>(
        'CoerceProduct',
        new Schema<IProduct>({ name: { type: String, required: true } }, { collection: 'coerce_products' }),
      );
    MovementModel =
      mongoose.models.CoerceMovement ??
      mongoose.model<IMovement>(
        'CoerceMovement',
        new Schema<IMovement>(
          { skuRef: { type: String, required: true }, qty: { type: Number, required: true } },
          { collection: 'coerce_movements' },
        ),
      );
  });

  afterAll(async () => {
    await ProductModel.deleteMany({});
    await MovementModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await ProductModel.deleteMany({});
    await MovementModel.deleteMany({});
    const product = await ProductModel.create({ name: 'Vintage Dinner Set' });
    productId = product._id;
    await MovementModel.create({ skuRef: String(product._id), qty: 5 });
  });

  it('the NAIVE join silently matches nothing — the defect being fixed', async () => {
    const stages = new LookupBuilder('coerce_products')
      .localField('skuRef')
      .foreignField('_id')
      .as('product')
      .build();

    const rows = await MovementModel.aggregate(stages);
    // Not an error. Not a warning. An empty array, which every caller reads as
    // "this SKU has no product".
    expect(rows[0].product).toEqual([]);
  });

  it('coerce: "objectId" matches, and carries the joined document', async () => {
    const stages = new LookupBuilder('coerce_products')
      .localField('skuRef')
      .foreignField('_id')
      .coerce('objectId')
      .as('product')
      .build();

    const rows = await MovementModel.aggregate(stages);
    expect(rows[0].product).toHaveLength(1);
    expect(rows[0].product[0]._id.toString()).toBe(productId.toString());
    expect(rows[0].product[0].name).toBe('Vintage Dinner Set');
  });

  it('a non-ObjectId reference MISSES rather than failing the whole query', async () => {
    // flow's `skuRef` legitimately admits plain SKU codes. `$toObjectId` throws
    // on the first one and takes down the entire aggregation — including every
    // healthy row. `$convert … onError: null` degrades to a miss instead.
    await MovementModel.create({ skuRef: 'LEGACY-SKU-CODE', qty: 2 });

    const stages = new LookupBuilder('coerce_products')
      .localField('skuRef')
      .foreignField('_id')
      .coerce('objectId')
      .as('product')
      .build();

    const rows = await MovementModel.aggregate(stages);
    expect(rows).toHaveLength(2);
    const byRef = Object.fromEntries(rows.map((r) => [r.skuRef, r.product]));
    expect(byRef[String(productId)]).toHaveLength(1);
    expect(byRef['LEGACY-SKU-CODE']).toEqual([]);
  });

  it('composes with single() so the caller gets an object, not an array', async () => {
    const stages = new LookupBuilder('coerce_products')
      .localField('skuRef')
      .foreignField('_id')
      .coerce('objectId')
      .single()
      .as('product')
      .build();

    const rows = await MovementModel.aggregate(stages);
    expect(rows[0].product?.name).toBe('Vintage Dinner Set');
  });

  it('coerces in the CUSTOM-pipeline branch too', async () => {
    // The auto-generated and custom-pipeline branches build their correlation
    // separately. Coercing only one leaves `coerce` accepted-and-ignored on the
    // other — a declared option that does nothing, which is the same silent
    // class this option exists to remove.
    const stages = new LookupBuilder('coerce_products')
      .localField('skuRef')
      .foreignField('_id')
      .coerce('objectId')
      .pipeline([{ $project: { name: 1 } }])
      .as('product')
      .build();

    const rows = await MovementModel.aggregate(stages);
    expect(rows[0].product).toHaveLength(1);
    expect(rows[0].product[0].name).toBe('Vintage Dinner Set');
  });

  it('declares the capability it implements', async () => {
    // A host cannot otherwise DETECT support: without the coercion the join
    // matches nothing and raises no error, so "unsupported" and "no matches"
    // look identical. Implemented-but-undeclared is as bad as declared-but-
    // unimplemented.
    const { MONGOKIT_CAPABILITIES } = await import('../../src/capabilities.js');
    expect(MONGOKIT_CAPABILITIES.lookupCoerce).toBe(true);
  });

  it('refuses a coercion it cannot apply, instead of ignoring it', async () => {
    expect(() =>
      new LookupBuilder('coerce_products').localField('skuRef').coerce('objectId').as('p').build(),
    ).toThrow(/coerce/i);
  });
});
