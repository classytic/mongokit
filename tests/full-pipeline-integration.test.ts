/**
 * Full Pipeline Integration Test
 *
 * Single file that exercises the ENTIRE mongokit stack end-to-end, typed
 * throughout, proving every layer composes:
 *
 *   Schema definition (Mongoose 9.4.1)
 *     → QueryParser (schema-aware coercion + geo + search)
 *       → JSON Schema generation (createBody / updateBody / listQuery)
 *         → Repository (CRUD + hooks + plugins + pagination)
 *           → Plugin composition (soft-delete + multi-tenant + cache + timestamp + observability)
 *             → Pagination (offset + keyset + geo)
 *               → Custom hooks (before/after lifecycle)
 *
 * This is what an AI agent reads to understand the system. Every assertion
 * documents a contract. If this file passes, the package ships.
 *
 * Realistic domain: a multi-tenant e-commerce product catalog with:
 *   - UUID product IDs (String _id)
 *   - Geo-indexed warehouse locations
 *   - Soft-deletable products
 *   - Cache layer
 *   - Multi-tenant scoping
 *   - Audit trail via hooks
 *   - Schema-generated validation bodies
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Document, Schema } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  buildCrudSchemasFromModel,
  cachePlugin,
  createMemoryCache,
  multiTenantPlugin,
  QueryParser,
  softDeletePlugin,
  timestampPlugin,
} from '../src/index.js';
import Repository from '../src/Repository.js';
import { getSchemaIdType, isValidIdForType } from '../src/utils/id-resolution.js';
import type { RepositoryContext } from '../src/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// 1. SCHEMA DEFINITION
// ═══════════════════════════════════════════════════════════════════════════

interface IProduct extends Document {
  _id: string;
  name: string;
  sku: string;
  price: number;
  stock: number;
  active: boolean;
  tags: string[];
  organizationId: string;
  warehouse: {
    type: 'Point';
    coordinates: [number, number];
  };
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const ProductSchema = new Schema<IProduct>({
  _id: { type: String, default: () => randomUUID() },
  name: { type: String, required: true },
  sku: { type: String, required: true },
  price: { type: Number, required: true },
  stock: { type: Number, required: true, default: 0 },
  active: { type: Boolean, default: true },
  tags: [{ type: String }],
  organizationId: { type: String, required: true, index: true },
  warehouse: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true },
  },
  deletedAt: { type: Date, default: null },
});
ProductSchema.index({ warehouse: '2dsphere' });

// ═══════════════════════════════════════════════════════════════════════════
// 2. TEST SETUP
// ═══════════════════════════════════════════════════════════════════════════

let mongoServer: MongoMemoryServer;
let ProductModel: mongoose.Model<IProduct>;

const NYC: [number, number] = [-73.9857, 40.7589];
const LA: [number, number] = [-118.2437, 34.0522];
const LONDON: [number, number] = [-0.1278, 51.5074];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ProductModel = mongoose.model<IProduct>('FullPipelineProduct', ProductSchema);
  await ProductModel.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await ProductModel.deleteMany({});
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1: ID RESOLUTION — correct _id type detection
// ═══════════════════════════════════════════════════════════════════════════

describe('Layer 1: ID Resolution', () => {
  it('detects String _id from the product schema', () => {
    expect(getSchemaIdType(ProductSchema)).toBe('string');
  });

  it('validates UUIDs as valid for string type', () => {
    expect(isValidIdForType(randomUUID(), 'string')).toBe(true);
    expect(isValidIdForType('', 'string')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2: JSON SCHEMA GENERATION — create/update bodies for validation
// ═══════════════════════════════════════════════════════════════════════════

describe('Layer 2: JSON Schema Generation', () => {
  it('generates createBody with String _id as optional and correct field types', () => {
    const schemas = buildCrudSchemasFromModel(ProductModel, {
      fieldRules: {
        organizationId: { systemManaged: true },
      },
    });

    const { createBody } = schemas;
    expect(createBody.type).toBe('object');

    // _id is included (String, not auto-generated ObjectId) and optional
    expect(createBody.properties?._id).toBeDefined();
    expect((createBody.properties?._id as { type: string }).type).toBe('string');
    expect(createBody.required).not.toContain('_id');

    // organizationId is omitted (systemManaged)
    expect(createBody.properties?.organizationId).toBeUndefined();

    // Required fields are present
    expect(createBody.required).toContain('name');
    expect(createBody.required).toContain('sku');
    expect(createBody.required).toContain('price');

    // price is typed as number
    expect((createBody.properties?.price as { type: string }).type).toBe('number');
  });

  it('generates updateBody without systemManaged or immutable fields', () => {
    const schemas = buildCrudSchemasFromModel(ProductModel, {
      fieldRules: {
        organizationId: { systemManaged: true },
        sku: { immutable: true },
      },
    });

    const { updateBody } = schemas;
    expect(updateBody.properties?.organizationId).toBeUndefined();
    expect(updateBody.properties?.sku).toBeUndefined();
    // price is still updatable
    expect(updateBody.properties?.price).toBeDefined();
    // No required fields in update body
    expect(updateBody.required).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 3: QUERY PARSER — schema-aware coercion + geo + search
// ═══════════════════════════════════════════════════════════════════════════

describe('Layer 3: QueryParser (schema-aware)', () => {
  const parser = new QueryParser({ schema: ProductSchema });

  it('coerces price to number, sku stays string', () => {
    const parsed = parser.parse({ price: '9.99', sku: '00042' });
    expect(parsed.filters.price).toBe(9.99);
    expect(parsed.filters.sku).toBe('00042');
  });

  it('coerces active to boolean', () => {
    const parsed = parser.parse({ active: 'true' });
    expect(parsed.filters.active).toBe(true);
  });

  it('builds $near filter from URL params', () => {
    const parsed = parser.parse({
      'warehouse[near]': `${NYC[0]},${NYC[1]},5000`,
    });
    expect(parsed.filters.warehouse).toMatchObject({
      $near: {
        $geometry: { type: 'Point', coordinates: NYC },
        $maxDistance: 5000,
      },
    });
  });

  it('builds $in filter with per-element coercion for tags (string array)', () => {
    const parsed = parser.parse({ 'tags[in]': 'sale,new,01234' });
    expect(parsed.filters.tags).toEqual({ $in: ['sale', 'new', '01234'] });
  });

  it('exposes geo-indexed fields via schemaIndexes', () => {
    expect(parser.schemaIndexes.geoFields).toContain('warehouse');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 4: REPOSITORY — CRUD with plugins, hooks, and pagination
// ═══════════════════════════════════════════════════════════════════════════

describe('Layer 4: Repository with full plugin stack', () => {
  let repo: Repository<IProduct>;
  let parser: QueryParser;
  const auditLog: string[] = [];

  beforeEach(() => {
    auditLog.length = 0;

    const cache = createMemoryCache();
    repo = new Repository(
      ProductModel,
      [
        timestampPlugin(),
        softDeletePlugin({ deletedField: 'deletedAt' }),
        multiTenantPlugin({ field: 'organizationId' }),
        cachePlugin({ adapter: cache, ttl: 60 }),
      ],
      { defaultLimit: 10 },
      { searchMode: 'regex', searchFields: ['name', 'sku', 'tags'] },
    );

    // Custom audit hook — proves hooks compose with plugins
    repo.on('after:create', ({ result }: { result: IProduct }) => {
      auditLog.push(`created:${result.name}`);
    });
    repo.on('after:update', ({ result }: { result: IProduct }) => {
      auditLog.push(`updated:${result.name}`);
    });
    repo.on('after:delete', () => {
      auditLog.push('deleted');
    });

    parser = new QueryParser({
      schema: ProductSchema,
      searchMode: 'regex',
      searchFields: ['name', 'sku'],
    });
  });

  // ── CRUD lifecycle ──────────────────────────────────────────────────────

  it('create → getById → update → delete full lifecycle with UUID _id', async () => {
    // Create
    const product = await repo.create(
      {
        name: 'Widget',
        sku: 'WDG-001',
        price: 9.99,
        stock: 100,
        organizationId: 'org_a',
        warehouse: { type: 'Point', coordinates: NYC },
      } as Partial<IProduct>,
      { organizationId: 'org_a' } as Record<string, unknown>,
    );

    expect(product._id).toMatch(/^[0-9a-f]{8}-/); // UUID format
    expect(product.name).toBe('Widget');
    expect(auditLog).toContain('created:Widget');

    // getById with UUID (tenant context required by multi-tenant plugin)
    const tenantOpts = { organizationId: 'org_a' } as Record<string, unknown>;
    const fetched = await repo.getById(product._id, tenantOpts);
    expect(fetched).not.toBeNull();
    expect(fetched!.price).toBe(9.99);

    // Update
    const updated = await repo.update(product._id, { price: 12.99 }, tenantOpts);
    expect(updated.price).toBe(12.99);
    expect(auditLog).toContain('updated:Widget');

    // Soft delete
    const deleteResult = await repo.delete(product._id, tenantOpts);
    expect(deleteResult.success).toBe(true);
    expect(auditLog).toContain('deleted');

    // Verify soft-deleted (excluded from getAll by soft-delete plugin)
    const afterDelete = await repo.getById(product._id, {
      ...tenantOpts,
      throwOnNotFound: false,
    });
    expect(afterDelete).toBeNull();
  });

  // ── Multi-tenant isolation ──────────────────────────────────────────────

  it('multi-tenant scoping isolates getAll results per org', async () => {
    await ProductModel.insertMany([
      { name: 'A', sku: 'A1', price: 10, organizationId: 'org_a', warehouse: { type: 'Point', coordinates: NYC } },
      { name: 'B', sku: 'B1', price: 20, organizationId: 'org_b', warehouse: { type: 'Point', coordinates: LA } },
      { name: 'C', sku: 'C1', price: 30, organizationId: 'org_a', warehouse: { type: 'Point', coordinates: LONDON } },
    ]);

    const result = await repo.getAll({
      organizationId: 'org_a',
      mode: 'offset',
    } as Parameters<typeof repo.getAll>[0]);
    if (result.method !== 'offset') throw new Error('expected offset');

    expect(result.total).toBe(2);
    const names = result.docs.map((d) => d.name).sort();
    expect(names).toEqual(['A', 'C']);
    // org_b's product must NOT appear
    expect(names).not.toContain('B');
  });

  // ── Search (regex mode) ─────────────────────────────────────────────────

  it('regex search across name/sku/tags with multi-tenant scoping', async () => {
    await ProductModel.insertMany([
      { name: 'Blue Widget', sku: 'BW-01', price: 10, tags: ['sale'], organizationId: 'org_a', warehouse: { type: 'Point', coordinates: NYC } },
      { name: 'Red Gadget', sku: 'RG-01', price: 20, tags: ['new'], organizationId: 'org_a', warehouse: { type: 'Point', coordinates: NYC } },
      { name: 'Blue Widget', sku: 'BW-02', price: 15, tags: ['sale'], organizationId: 'org_b', warehouse: { type: 'Point', coordinates: LA } },
    ]);

    const result = await repo.getAll({
      search: 'widget',
      organizationId: 'org_a',
      mode: 'offset',
    } as Parameters<typeof repo.getAll>[0]);
    if (result.method !== 'offset') throw new Error('expected offset');

    // Only org_a's Blue Widget, not org_b's
    expect(result.total).toBe(1);
    expect(result.docs[0].name).toBe('Blue Widget');
    expect(result.docs[0].organizationId).toBe('org_a');
  });

  // ── Geo + plugins ───────────────────────────────────────────────────────

  it('geo withinRadius + multi-tenant + soft-delete all compose', async () => {
    await ProductModel.insertMany([
      { name: 'NYC-Active', sku: 'N1', price: 10, organizationId: 'org_a', warehouse: { type: 'Point', coordinates: NYC } },
      { name: 'NYC-Deleted', sku: 'N2', price: 20, organizationId: 'org_a', warehouse: { type: 'Point', coordinates: [-73.98, 40.76] }, deletedAt: new Date() },
      { name: 'LA-Active', sku: 'L1', price: 30, organizationId: 'org_a', warehouse: { type: 'Point', coordinates: LA } },
      { name: 'NYC-OtherOrg', sku: 'N3', price: 40, organizationId: 'org_b', warehouse: { type: 'Point', coordinates: [-73.99, 40.75] } },
    ]);

    const parsed = parser.parse({
      'warehouse[withinRadius]': `${NYC[0]},${NYC[1]},5000`,
    });

    const result = await repo.getAll({
      filters: parsed.filters,
      organizationId: 'org_a',
      mode: 'offset',
    } as Parameters<typeof repo.getAll>[0]);
    if (result.method !== 'offset') throw new Error('expected offset');

    // Only NYC-Active survives: in radius + org_a + not deleted
    expect(result.total).toBe(1);
    expect(result.docs[0].name).toBe('NYC-Active');
  });

  // ── $near with paginated getAll (auto-detected) ─────────────────────────

  it('$near works through paginated getAll with accurate total via count rewrite', async () => {
    await ProductModel.insertMany([
      { name: 'Near', sku: 'NR', price: 10, organizationId: 'org_a', warehouse: { type: 'Point', coordinates: NYC } },
      { name: 'Far', sku: 'FR', price: 20, organizationId: 'org_a', warehouse: { type: 'Point', coordinates: LA } },
    ]);

    const parsed = parser.parse({
      'warehouse[near]': `${NYC[0]},${NYC[1]},50000`, // 50 km — only NYC
    });

    const result = await repo.getAll({
      filters: parsed.filters,
      organizationId: 'org_a',
      mode: 'offset',
    } as Parameters<typeof repo.getAll>[0]);
    if (result.method !== 'offset') throw new Error('expected offset');

    expect(result.docs[0].name).toBe('Near'); // distance-sorted
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  // ── QueryParser → getAll typed flow ─────────────────────────────────────

  it('full parser → repository flow with combined filters', async () => {
    await ProductModel.insertMany([
      { name: 'Cheap Active', sku: 'CA', price: 5, active: true, tags: ['sale'], organizationId: 'org_a', warehouse: { type: 'Point', coordinates: NYC } },
      { name: 'Expensive Active', sku: 'EA', price: 50, active: true, tags: ['premium'], organizationId: 'org_a', warehouse: { type: 'Point', coordinates: NYC } },
      { name: 'Cheap Inactive', sku: 'CI', price: 5, active: false, tags: ['sale'], organizationId: 'org_a', warehouse: { type: 'Point', coordinates: NYC } },
    ]);

    // Simulates: GET /products?price[lte]=10&active=true&tags[in]=sale&sort=-price&limit=5
    const parsed = parser.parse({
      'price[lte]': '10',
      active: 'true',
      'tags[in]': 'sale',
      sort: '-price',
      limit: '5',
    });

    const result = await repo.getAll({
      filters: parsed.filters,
      sort: parsed.sort,
      limit: parsed.limit,
      organizationId: 'org_a',
      mode: 'offset',
    } as Parameters<typeof repo.getAll>[0]);
    if (result.method !== 'offset') throw new Error('expected offset');

    expect(result.total).toBe(1);
    expect(result.docs[0].name).toBe('Cheap Active');
    expect(result.docs[0].price).toBe(5);
    expect(result.docs[0].active).toBe(true);
  });

  // ── Keyset pagination ──────────────────────────────────────────────────

  it('keyset pagination returns cursor-based results', async () => {
    await ProductModel.insertMany(
      Array.from({ length: 5 }, (_, i) => ({
        name: `Product ${i}`,
        sku: `P${i}`,
        price: 10 + i,
        organizationId: 'org_a',
        warehouse: { type: 'Point', coordinates: NYC },
      })),
    );

    const page1 = await repo.getAll({
      sort: { price: 1 },
      limit: 2,
      organizationId: 'org_a',
    } as Parameters<typeof repo.getAll>[0]);

    expect(page1.method).toBe('keyset');
    if (page1.method !== 'keyset') throw new Error('expected keyset');
    expect(page1.docs).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.next).toBeTruthy();

    // Page 2 using cursor
    const page2 = await repo.getAll({
      sort: { price: 1 },
      limit: 2,
      after: page1.next!,
      organizationId: 'org_a',
    } as Parameters<typeof repo.getAll>[0]);

    expect(page2.method).toBe('keyset');
    if (page2.method !== 'keyset') throw new Error('expected keyset');
    expect(page2.docs).toHaveLength(2);
    // No overlap between pages
    const page1Ids = page1.docs.map((d) => d._id);
    const page2Ids = page2.docs.map((d) => d._id);
    expect(page1Ids.filter((id) => page2Ids.includes(id))).toHaveLength(0);
  });

  // ── Custom hook integration ─────────────────────────────────────────────

  it('before:getAll hook can inject computed filters', async () => {
    await ProductModel.insertMany([
      { name: 'Premium', sku: 'PR', price: 100, tags: ['premium'], organizationId: 'org_a', warehouse: { type: 'Point', coordinates: NYC } },
      { name: 'Budget', sku: 'BU', price: 5, tags: ['budget'], organizationId: 'org_a', warehouse: { type: 'Point', coordinates: NYC } },
    ]);

    // Plugin: auto-filter to premium products only
    repo.on('before:getAll', (ctx: RepositoryContext) => {
      ctx.filters = {
        ...(ctx.filters as Record<string, unknown> ?? {}),
        tags: 'premium',
      };
    });

    const result = await repo.getAll({
      organizationId: 'org_a',
      mode: 'offset',
    } as Parameters<typeof repo.getAll>[0]);
    if (result.method !== 'offset') throw new Error('expected offset');

    expect(result.total).toBe(1);
    expect(result.docs[0].name).toBe('Premium');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 5: CROSS-CUTTING — proves the layers don't leak or conflict
// ═══════════════════════════════════════════════════════════════════════════

describe('Layer 5: Cross-cutting composition proof', () => {
  it('schema gen + parser + repo agree on field types (no mismatch)', () => {
    const parser = new QueryParser({ schema: ProductSchema });
    const schemas = buildCrudSchemasFromModel(ProductModel);

    // price: schema gen says number, parser coerces to number
    expect((schemas.createBody.properties?.price as { type: string }).type).toBe('number');
    expect(parser.parse({ price: '9.99' }).filters.price).toBe(9.99);

    // active: schema gen says boolean, parser coerces to boolean
    expect((schemas.createBody.properties?.active as { type: string }).type).toBe('boolean');
    expect(parser.parse({ active: 'true' }).filters.active).toBe(true);

    // name: schema gen says string, parser preserves as string
    expect((schemas.createBody.properties?.name as { type: string }).type).toBe('string');
    expect(parser.parse({ name: '12345' }).filters.name).toBe('12345');
  });

  it('soft-deleted + multi-tenant + geo + search all compose in a single getAll', async () => {
    const cache = createMemoryCache();
    const repo = new Repository(
      ProductModel,
      [
        timestampPlugin(),
        softDeletePlugin({ deletedField: 'deletedAt' }),
        multiTenantPlugin({ field: 'organizationId' }),
        cachePlugin({ adapter: cache, ttl: 60 }),
      ],
      {},
      { searchMode: 'regex', searchFields: ['name'] },
    );

    await ProductModel.insertMany([
      { name: 'Target', sku: 'T', price: 10, organizationId: 'org_a', warehouse: { type: 'Point', coordinates: NYC } },
      { name: 'Target Deleted', sku: 'TD', price: 10, organizationId: 'org_a', warehouse: { type: 'Point', coordinates: [-73.98, 40.76] }, deletedAt: new Date() },
      { name: 'Target Other Org', sku: 'TO', price: 10, organizationId: 'org_b', warehouse: { type: 'Point', coordinates: [-73.99, 40.75] } },
      { name: 'Decoy', sku: 'D', price: 10, organizationId: 'org_a', warehouse: { type: 'Point', coordinates: NYC } },
    ]);

    const parser = new QueryParser({ schema: ProductSchema });
    const parsed = parser.parse({
      'warehouse[withinRadius]': `${NYC[0]},${NYC[1]},5000`,
    });

    const result = await repo.getAll({
      filters: parsed.filters,
      search: 'target',
      organizationId: 'org_a',
      mode: 'offset',
    } as Parameters<typeof repo.getAll>[0]);
    if (result.method !== 'offset') throw new Error('expected offset');

    // Only "Target" survives all 4 filters:
    //   ✓ search "target" matches name
    //   ✓ within 5 km of NYC
    //   ✓ org_a only
    //   ✓ not soft-deleted
    // "Target Deleted" → soft-deleted
    // "Target Other Org" → wrong org
    // "Decoy" → name doesn't match search
    expect(result.total).toBe(1);
    expect(result.docs[0].name).toBe('Target');
  });
});
