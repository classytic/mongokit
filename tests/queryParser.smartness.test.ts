/**
 * QueryParser — adversarial / "is it actually smart" tests
 *
 * Goal: probe the new schema-aware parser AND the no-schema fallback with the
 * messy inputs real APIs receive — values that almost-look-like-types,
 * mongo-pun strings, mixed user input, deeply-nested mistakes, edge cases
 * that should NOT crash, and end-to-end queries that must actually return
 * correct documents from a real Mongoose collection.
 *
 * If any of these fail or behave surprisingly, the design has a hole and
 * we have to fix it before publishing — not after.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Document, Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryParser } from '../src/index.js';
import Repository from '../src/Repository.js';

// ── Real fixture model with diverse types ────────────────────────────────

interface IProduct extends Document {
  sku: string; // String — must preserve leading zeros and numeric-looking IDs
  name: string;
  stock: number; // Number
  price: number; // Number (decimals)
  active: boolean; // Boolean
  releasedAt: Date; // Date
  ownerId: mongoose.Types.ObjectId; // ObjectId
  tags: string[]; // [String]
  ratings: number[]; // [Number]
  meta: { // Nested
    region: string;
    floor: number;
  };
}

const ProductSchema = new Schema<IProduct>({
  sku: { type: String, required: true },
  name: { type: String, required: true },
  stock: { type: Number, required: true },
  price: { type: Number, required: true },
  active: { type: Boolean, default: true },
  releasedAt: { type: Date, required: true },
  ownerId: { type: Schema.Types.ObjectId, required: true },
  tags: [{ type: String }],
  ratings: [{ type: Number }],
  meta: {
    region: { type: String },
    floor: { type: Number },
  },
});

let mongoServer: MongoMemoryServer;
let ProductModel: mongoose.Model<IProduct>;
let repo: Repository<IProduct>;
let parserWithSchema: QueryParser;
let parserNoSchema: QueryParser;

const owner1 = new mongoose.Types.ObjectId();
const owner2 = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ProductModel = mongoose.model<IProduct>('SmartProduct', ProductSchema);
  repo = new Repository(ProductModel);
  parserWithSchema = new QueryParser({ schema: ProductSchema });
  parserNoSchema = new QueryParser();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await ProductModel.deleteMany({});
  await ProductModel.insertMany([
    {
      sku: '00042', // leading-zero SKU — must NOT become number 42
      name: 'Widget',
      stock: 50,
      price: 9.99,
      active: true,
      releasedAt: new Date('2026-01-15'),
      ownerId: owner1,
      tags: ['sale', 'new'],
      ratings: [5, 4, 3],
      meta: { region: 'US', floor: 2 },
    },
    {
      sku: '12345678901234', // 14-digit SKU — must NOT become number (precision risk)
      name: 'Gadget',
      stock: 0,
      price: 19.5,
      active: false,
      releasedAt: new Date('2026-03-01'),
      ownerId: owner2,
      tags: ['clearance'],
      ratings: [2],
      meta: { region: 'EU', floor: 10 },
    },
    {
      sku: 'ABC-100',
      name: 'Thingamajig',
      stock: 100,
      price: 0.5,
      active: true,
      releasedAt: new Date('2026-02-01'),
      ownerId: owner1,
      tags: ['sale'],
      ratings: [],
      meta: { region: 'US', floor: 1 },
    },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────
// END-TO-END: parser output must actually find the right docs
// ─────────────────────────────────────────────────────────────────────────

describe('Smartness E2E: schema-aware parser → real Mongo query', () => {
  it('?stock=50 finds the widget (was the original bug)', async () => {
    const parsed = parserWithSchema.parse({ stock: '50' });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(1);
    expect(result.docs[0].name).toBe('Widget');
  });

  it('?sku=00042 finds the leading-zero SKU as a string match', async () => {
    const parsed = parserWithSchema.parse({ sku: '00042' });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(1);
    expect(result.docs[0].name).toBe('Widget');
  });

  it('?sku=12345678901234 finds the 14-digit SKU as a string', async () => {
    const parsed = parserWithSchema.parse({ sku: '12345678901234' });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(1);
    expect(result.docs[0].name).toBe('Gadget');
  });

  it('?price[gte]=10&price[lte]=20 finds Gadget (decimal range)', async () => {
    const parsed = parserWithSchema.parse({ 'price[gte]': '10', 'price[lte]': '20' });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(1);
    expect(result.docs[0].name).toBe('Gadget');
  });

  it('?active=false finds the inactive Gadget', async () => {
    const parsed = parserWithSchema.parse({ active: 'false' });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(1);
    expect(result.docs[0].name).toBe('Gadget');
  });

  it('?releasedAt[gte]=2026-02-01 finds Gadget and Thingamajig (date range)', async () => {
    const parsed = parserWithSchema.parse({ 'releasedAt[gte]': '2026-02-01' });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset', sort: 'name' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(2);
    expect(result.docs.map((d) => d.name).sort()).toEqual(['Gadget', 'Thingamajig']);
  });

  it(`?ownerId=${owner1.toHexString()} finds Widget and Thingamajig`, async () => {
    const parsed = parserWithSchema.parse({ ownerId: owner1.toHexString() });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset', sort: 'name' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(2);
  });

  it('?meta.region=US&meta.floor[gte]=2 finds the Widget on floor 2', async () => {
    const parsed = parserWithSchema.parse({
      'meta.region': 'US',
      'meta.floor[gte]': '2',
    });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(1);
    expect(result.docs[0].name).toBe('Widget');
  });

  it('?ratings[in]=4,5 finds Widget (numeric array $in)', async () => {
    const parsed = parserWithSchema.parse({ 'ratings[in]': '4,5' });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(1);
    expect(result.docs[0].name).toBe('Widget');
  });

  it('?tags[in]=sale finds Widget and Thingamajig (string array $in, no coercion)', async () => {
    const parsed = parserWithSchema.parse({ 'tags[in]': 'sale' });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset', sort: 'name' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(2);
  });

  it('?or[0][stock]=50&or[1][stock]=0 finds Widget and Gadget via $or numeric coercion', async () => {
    const parsed = parserWithSchema.parse({
      or: [{ stock: '50' }, { stock: '0' }],
    });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset', sort: 'name' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(2);
    expect(result.docs.map((d) => d.name).sort()).toEqual(['Gadget', 'Widget']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FALLBACK: parser without schema must still be safe and useful
// ─────────────────────────────────────────────────────────────────────────

describe('Smartness fallback: no-schema parser still works for ad-hoc APIs', () => {
  it('coerces obvious numbers and finds the doc', async () => {
    const parsed = parserNoSchema.parse({ stock: '50' });
    expect(parsed.filters.stock).toBe(50);
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(1);
  });

  it('preserves leading-zero strings (zip / SKU / phone code)', async () => {
    const parsed = parserNoSchema.parse({ sku: '00042' });
    expect(parsed.filters.sku).toBe('00042');
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(1);
  });

  it('preserves long numeric strings beyond JS safe-integer range', async () => {
    const longId = '12345678901234567890'; // 20 digits — far beyond Number.MAX_SAFE_INTEGER
    const parsed = parserNoSchema.parse({ legacyId: longId });
    expect(parsed.filters.legacyId).toBe(longId);
    expect(typeof parsed.filters.legacyId).toBe('string');
  });

  it('coerces booleans from "true"/"false" but not from "1"/"0" (no-schema)', async () => {
    expect(parserNoSchema.parse({ active: 'true' }).filters.active).toBe(true);
    expect(parserNoSchema.parse({ active: 'false' }).filters.active).toBe(false);
    // Without schema, "1" is ambiguous — number is the safer guess.
    // With schema saying Boolean, "1" becomes true. This asymmetry is intentional.
    expect(parserNoSchema.parse({ count: '1' }).filters.count).toBe(1);
  });

  it('handles ObjectId hex without coercing it to a number', async () => {
    const id = owner1.toHexString();
    const parsed = parserNoSchema.parse({ ownerId: id });
    expect(parsed.filters.ownerId).toBe(id);
    expect(typeof parsed.filters.ownerId).toBe('string');
  });

  it('does not crash on negative numbers, zero, decimals, or empty strings', () => {
    expect(parserNoSchema.parse({ x: '-5' }).filters.x).toBe(-5);
    expect(parserNoSchema.parse({ x: '0' }).filters.x).toBe(0);
    expect(parserNoSchema.parse({ x: '3.14' }).filters.x).toBe(3.14);
    // Empty string should not crash and should not become NaN/0
    expect(parserNoSchema.parse({ x: '' }).filters.x).toBe('');
  });

  it('rejects scientific notation as-string (avoids parsing 1e308 to Infinity)', () => {
    const parsed = parserNoSchema.parse({ x: '1e10', y: '1e308' });
    expect(parsed.filters.x).toBe('1e10');
    expect(parsed.filters.y).toBe('1e308');
  });

  it('rejects hex/octal-looking strings — only plain decimals coerce', () => {
    const parsed = parserNoSchema.parse({ x: '0x10', y: '0o7' });
    expect(parsed.filters.x).toBe('0x10');
    expect(parsed.filters.y).toBe('0o7');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// EDGE CASES: things that could trip up a naïve implementation
// ─────────────────────────────────────────────────────────────────────────

describe('Smartness edge cases (must not crash, must do the obvious thing)', () => {
  it('schema-aware parser is unaffected by nullish/undefined values', () => {
    const parsed = parserWithSchema.parse({ stock: undefined as unknown as string });
    expect(parsed.filters.stock).toBeUndefined();
  });

  it('coerces values inside deeply-nested $or (depth=2 still works)', () => {
    const parsed = parserWithSchema.parse({
      or: [{ stock: '50' }, { stock: '0' }, { stock: '100' }],
    });
    expect(parsed.filters.$or).toEqual([{ stock: 50 }, { stock: 0 }, { stock: 100 }]);
  });

  it('schema-aware NUMBER field with garbage input falls back to original value', () => {
    // Better to leave garbage than emit NaN, which Mongo would treat as a real query value.
    const parsed = parserWithSchema.parse({ stock: 'not-a-number' });
    expect(parsed.filters.stock).toBe('not-a-number');
  });

  it('schema-aware DATE field with garbage input falls back to original value', () => {
    const parsed = parserWithSchema.parse({ releasedAt: 'definitely-not-a-date' });
    expect(parsed.filters.releasedAt).toBe('definitely-not-a-date');
  });

  it('schema-aware OBJECTID field with non-hex input falls back', () => {
    const parsed = parserWithSchema.parse({ ownerId: 'not-an-id' });
    expect(parsed.filters.ownerId).toBe('not-an-id');
  });

  it('coerces equality and operator paths identically when both used together', () => {
    // `[eq]` short-circuits to direct equality (a Mongo idiom: `{ field: 50 }`
    // is the canonical form, `{ field: { $eq: 50 } }` is verbose-equivalent).
    // Both forms are recognized but the parser normalizes to direct equality
    // for minimal filter shape. Range operators always produce the wrapper.
    const direct = parserWithSchema.parse({ stock: '50' }).filters.stock;
    const eqOp = parserWithSchema.parse({ 'stock[eq]': '50' }).filters.stock;
    const gtOp = parserWithSchema.parse({ 'stock[gte]': '50' }).filters.stock;
    expect(direct).toBe(50);
    expect(eqOp).toBe(50); // collapsed to direct equality
    expect(gtOp).toEqual({ $gte: 50 });
  });

  it('handles already-typed primitives (number/boolean) without re-coercing', () => {
    const parsed = parserWithSchema.parse({
      stock: 50 as unknown as string,
      active: true as unknown as string,
    });
    expect(parsed.filters.stock).toBe(50);
    expect(parsed.filters.active).toBe(true);
  });

  it('combines schema-aware coercion with allowedFilterFields whitelist', () => {
    const parser = new QueryParser({
      schema: ProductSchema,
      allowedFilterFields: ['stock', 'sku'],
    });
    const parsed = parser.parse({ stock: '50', sku: '00042', name: 'blocked' });
    expect(parsed.filters.stock).toBe(50);
    expect(parsed.filters.sku).toBe('00042');
    expect(parsed.filters.name).toBeUndefined();
  });

  it('still blocks dangerous operators when schema is configured', () => {
    const parsed = parserWithSchema.parse({
      stock: '50',
      $where: 'this.secret === true',
    });
    expect(parsed.filters.stock).toBe(50);
    expect(parsed.filters.$where).toBeUndefined();
  });

  it('schema-aware parser drops empty $or branches after sanitizing dangerous keys', () => {
    const parsed = parserWithSchema.parse({
      or: [{ $where: 'evil' }, { stock: '50' }],
    });
    expect(parsed.filters.$or).toEqual([{ stock: 50 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// REAL-WORLD URL strings — does it survive what an actual HTTP server passes?
// ─────────────────────────────────────────────────────────────────────────

describe('Smartness real-world URL parsing (qs-style decoded objects)', () => {
  it('handles a kitchen-sink query as a Fastify/Express handler would receive it', async () => {
    // Simulates: ?stock[gte]=10&active=true&meta.region=US&tags[in]=sale,new&sort=-stock&limit=2&page=1
    const decoded = {
      'stock[gte]': '10',
      active: 'true',
      'meta.region': 'US',
      'tags[in]': 'sale,new',
      sort: '-stock',
      limit: '2',
      page: '1',
    };
    const parsed = parserWithSchema.parse(decoded);

    // Filters
    expect(parsed.filters.stock).toEqual({ $gte: 10 });
    expect(parsed.filters.active).toBe(true);
    expect(parsed.filters['meta.region']).toBe('US');
    expect(parsed.filters.tags).toEqual({ $in: ['sale', 'new'] });
    // Pagination
    expect(parsed.limit).toBe(2);
    expect(parsed.page).toBe(1);
    // Sort
    expect(parsed.sort).toEqual({ stock: -1 });

    // And the query actually returns docs
    const result = await repo.getAll({
      filters: parsed.filters,
      sort: parsed.sort,
      page: parsed.page,
      limit: parsed.limit,
      mode: 'offset',
    });
    if (result.method !== 'offset') throw new Error('expected offset');
    // Widget (stock 50, active, US, has sale+new) and Thingamajig (stock 100, active, US, has sale)
    expect(result.total).toBe(2);
    expect(result.docs[0].stock).toBe(100); // sorted desc
  });

  it('handles a query the no-schema parser would also see correctly', async () => {
    const decoded = {
      'stock[gte]': '10',
      active: 'true',
    };
    const parsed = parserNoSchema.parse(decoded);
    // [gte] always parseFloat-coerces, regardless of schema
    expect(parsed.filters.stock).toEqual({ $gte: 10 });
    // active=true → boolean via heuristic
    expect(parsed.filters.active).toBe(true);

    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(2);
  });
});
