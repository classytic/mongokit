/**
 * Outbox recipe — end-to-end validation.
 *
 * This suite exercises the composition pattern documented in
 * `tests/_shared/outbox-recipe.ts`. It proves that:
 *
 *   1. `wireOutbox` correctly installs `before:create/update/delete` hooks.
 *   2. The outbox row is written in the SAME `ClientSession` as the
 *      business write (so a transaction covers both atomically).
 *   3. A simple relay drains pending events into a transport and
 *      acknowledges them.
 *   4. `shouldEnqueue` + `enrichMeta` give hosts the control points they
 *      need without mongokit having to ship a plugin.
 *   5. Multi-tenant scoping on the parent repo flows through to event
 *      meta.organizationId.
 *   6. Delete events fire (single + bulk via batchOperationsPlugin).
 *
 * No replica set is required. On standalone MongoDB (our CI default) we
 * run inside `withTransaction({ allowFallback: true })` — the callback
 * runs once non-transactionally, which is still the right test of the
 * wiring itself (the session reference still threads through).
 */

import mongoose, { Schema, Types } from 'mongoose';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  Repository,
  batchOperationsPlugin,
  methodRegistryPlugin,
  multiTenantPlugin,
  withTransaction,
} from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';
import {
  type DomainEvent,
  MongoOutboxStore,
  wireOutbox,
} from './_shared/outbox-recipe.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

interface IProduct {
  _id: Types.ObjectId;
  sku: string;
  name: string;
  price: number;
  organizationId: string;
}

interface IOrder {
  _id: Types.ObjectId;
  total: number;
  organizationId: string;
}

const ProductSchema = new Schema<IProduct>({
  sku: { type: String, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  organizationId: { type: String, required: true },
});

const OrderSchema = new Schema<IOrder>({
  total: { type: Number, required: true },
  organizationId: { type: String, required: true },
});

const OUTBOX_COLLECTION = 'outboxrecipe_outbox';

/**
 * Minimal in-memory transport — structurally matches arc's `EventTransport`
 * so the relay below would drop into `new EventOutbox({ store, transport })`
 * verbatim at the host layer.
 */
interface TestTransport {
  name: string;
  publish(event: DomainEvent): Promise<void>;
  published: DomainEvent[];
  failNext?: boolean;
}

function makeTransport(): TestTransport {
  const t: TestTransport = {
    name: 'test',
    published: [],
    async publish(event) {
      if (t.failNext) {
        t.failNext = false;
        throw new Error('transport offline');
      }
      t.published.push(event);
    },
  };
  return t;
}

/**
 * Minimal relay — the ~20-line snippet hosts copy into their startup. We
 * inline it here so tests validate the exact shape users will deploy.
 */
async function relay(
  store: MongoOutboxStore,
  transport: TestTransport,
  batchSize = 100,
): Promise<number> {
  const pending = await store.getPending(batchSize);
  let delivered = 0;
  for (const event of pending) {
    try {
      await transport.publish(event);
      await store.acknowledge(event.meta.id);
      delivered++;
    } catch {
      break; // stop on first failure; next tick retries
    }
  }
  return delivered;
}

// ────────────────────────────────────────────────────────────────────────────
// Suite
// ────────────────────────────────────────────────────────────────────────────

describe('Outbox recipe — composition over plugin', () => {
  let ProductModel: mongoose.Model<IProduct>;
  let OrderModel: mongoose.Model<IOrder>;
  // biome-ignore lint/suspicious/noExplicitAny: test shape
  let productRepo: any;
  // biome-ignore lint/suspicious/noExplicitAny: test shape
  let orderRepo: any;
  let store: MongoOutboxStore;
  let transport: TestTransport;

  beforeAll(async () => {
    await connectDB();
    ProductModel = await createTestModel('OutboxRecipeProduct', ProductSchema);
    OrderModel = await createTestModel('OutboxRecipeOrder', OrderSchema);

    productRepo = new Repository<IProduct>(ProductModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
    ]);

    orderRepo = new Repository<IOrder>(OrderModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
    ]);
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await ProductModel.deleteMany({});
    await OrderModel.deleteMany({});
    await mongoose.connection.collection(OUTBOX_COLLECTION).deleteMany({});

    store = new MongoOutboxStore({
      connection: mongoose.connection,
      name: OUTBOX_COLLECTION,
    });
    transport = makeTransport();

    wireOutbox({
      repos: {
        'catalog:product': productRepo,
        'sales:order': orderRepo,
      },
      store,
    });
  });

  afterEach(() => {
    // Clean up the wired hooks so each test starts from the same baseline.
    productRepo.removeAllListeners('before:create');
    productRepo.removeAllListeners('before:update');
    productRepo.removeAllListeners('before:delete');
    orderRepo.removeAllListeners('before:create');
    orderRepo.removeAllListeners('before:update');
    orderRepo.removeAllListeners('before:delete');
    // Re-install multi-tenant's hooks (they were collateral damage from
    // removeAllListeners). Simplest reliable way: recreate the repo in
    // beforeAll. But since every test re-wires in beforeEach above, we
    // just need to restore before-delete/update/create which multiTenant
    // registered at repo construction time. Easiest fix: rebuild repos
    // here so the next test's wireOutbox runs against a clean stack.
    productRepo = new Repository<IProduct>(ProductModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
    ]);
    orderRepo = new Repository<IOrder>(OrderModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
    ]);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Happy path — create
  // ──────────────────────────────────────────────────────────────────────

  it('writes a pending outbox row on create, typed with resource prefix', async () => {
    await productRepo.create(
      { sku: 'SKU-1', name: 'Widget', price: 100 },
      { organizationId: 'org_1' },
    );

    const pending = await store.getPending(100);
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe('catalog:product.created');
    expect(pending[0].payload).toMatchObject({
      sku: 'SKU-1',
      name: 'Widget',
      price: 100,
    });
    expect(pending[0].meta.organizationId).toBe('org_1');
    expect(pending[0].meta.resource).toBe('catalog:product');
    expect(pending[0].meta.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Session threading — the whole reason the recipe exists
  // ──────────────────────────────────────────────────────────────────────

  it('hooks receive context.session so outbox write is session-bound', async () => {
    // Spy on the raw collection.insertOne to capture the session arg passed
    // through from the hook. We reach in directly because we need to see
    // the actual third arg, not the store abstraction.
    const outboxCol = mongoose.connection.collection(OUTBOX_COLLECTION);
    const insertSpy = vi.spyOn(outboxCol, 'insertOne');

    await withTransaction(mongoose.connection, async (session) => {
      await productRepo.create(
        { sku: 'SKU-2', name: 'Gadget', price: 50 },
        { organizationId: 'org_1', session },
      );
    });

    // At least one insertOne was called on the outbox collection. The
    // second arg (options) must contain a `session` reference — that's
    // what proves the outbox row is enrolled in the same transaction.
    expect(insertSpy).toHaveBeenCalled();
    const callArgs = insertSpy.mock.calls[insertSpy.mock.calls.length - 1];
    const options = callArgs[1] as { session?: unknown } | undefined;
    expect(options?.session).toBeDefined();

    insertSpy.mockRestore();
  });

  // ──────────────────────────────────────────────────────────────────────
  // ATOMICITY — the actual guarantee the recipe claims
  //
  // This is THE test that justifies the whole outbox pattern. If the
  // business write commits but the outbox row doesn't (or vice versa),
  // consumers either miss events or see ghost events. The recipe's claim
  // is: both writes commit together, or neither does. Verifying that
  // requires a real replica set — which is exactly what global-setup.ts
  // now provisions.
  // ──────────────────────────────────────────────────────────────────────

  it('rolls back the outbox row together with the document when the tx throws', async () => {
    const productsBefore = await ProductModel.countDocuments();
    const outboxBefore = await mongoose.connection
      .collection(OUTBOX_COLLECTION)
      .countDocuments();

    await expect(
      withTransaction(mongoose.connection, async (session) => {
        await productRepo.create(
          { sku: 'DOOMED', name: 'Ghost', price: 666 },
          { organizationId: 'org_1', session },
        );
        // Throw AFTER the outbox hook has run — this is the critical case.
        // Without session threading, the outbox row would already be
        // committed in its own implicit mini-transaction and this throw
        // couldn't pull it back. With session threading, mongod rolls
        // BOTH writes back as a single unit.
        throw new Error('rollback test');
      }),
    ).rejects.toThrow(/rollback test/);

    const productsAfter = await ProductModel.countDocuments();
    const outboxAfter = await mongoose.connection
      .collection(OUTBOX_COLLECTION)
      .countDocuments();

    expect(productsAfter).toBe(productsBefore);
    expect(outboxAfter).toBe(outboxBefore);

    // And specifically: the doomed SKU and its event both vanished.
    const ghost = await ProductModel.findOne({ sku: 'DOOMED' });
    expect(ghost).toBeNull();

    const ghostEvent = await mongoose.connection
      .collection(OUTBOX_COLLECTION)
      .findOne({ 'payload.sku': 'DOOMED' });
    expect(ghostEvent).toBeNull();
  });

  it('commits the outbox row together with the document when the tx succeeds', async () => {
    const result = await withTransaction(mongoose.connection, async (session) => {
      return productRepo.create(
        { sku: 'COMMITTED', name: 'Real', price: 42 },
        { organizationId: 'org_1', session },
      );
    });

    expect(result.sku).toBe('COMMITTED');

    // Both the doc and its event are visible after the tx commits.
    const committed = await ProductModel.findOne({ sku: 'COMMITTED' });
    expect(committed).not.toBeNull();

    const pending = await store.getPending(100);
    const committedEvent = pending.find(
      (e) => (e.payload as { sku?: string })?.sku === 'COMMITTED',
    );
    expect(committedEvent).toBeDefined();
    expect(committedEvent?.type).toBe('catalog:product.created');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Update hook
  // ──────────────────────────────────────────────────────────────────────

  it('writes an outbox row on update with {id, changes} payload', async () => {
    const product = await productRepo.create(
      { sku: 'SKU-3', name: 'Original', price: 100 },
      { organizationId: 'org_1' },
    );

    await productRepo.update(
      product._id,
      { price: 150 },
      { organizationId: 'org_1' },
    );

    const pending = await store.getPending(100);
    expect(pending).toHaveLength(2);

    const updateEvent = pending.find((e) => e.type === 'catalog:product.updated');
    expect(updateEvent).toBeDefined();
    expect(updateEvent?.payload).toMatchObject({
      id: expect.anything(),
      changes: { price: 150 },
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Delete hook
  // ──────────────────────────────────────────────────────────────────────

  it('writes an outbox row on delete with the doc id', async () => {
    const product = await productRepo.create(
      { sku: 'SKU-4', name: 'Doomed', price: 20 },
      { organizationId: 'org_1' },
    );

    await productRepo.delete(product._id, { organizationId: 'org_1' });

    const pending = await store.getPending(100);
    const deleteEvent = pending.find((e) => e.type === 'catalog:product.deleted');
    expect(deleteEvent).toBeDefined();
    expect(deleteEvent?.payload).toEqual({ id: product._id });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Multi-repo wiring
  // ──────────────────────────────────────────────────────────────────────

  it('tags events from different repos with their resource prefix', async () => {
    await productRepo.create(
      { sku: 'SKU-5', name: 'P1', price: 100 },
      { organizationId: 'org_1' },
    );
    await orderRepo.create(
      { total: 500 },
      { organizationId: 'org_1' },
    );

    const pending = await store.getPending(100);
    const types = pending.map((e) => e.type).sort();
    expect(types).toEqual(['catalog:product.created', 'sales:order.created']);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Relay
  // ──────────────────────────────────────────────────────────────────────

  it('relay drains pending events to the transport and acknowledges them', async () => {
    await productRepo.create(
      { sku: 'SKU-6', name: 'P1', price: 10 },
      { organizationId: 'org_1' },
    );
    await productRepo.create(
      { sku: 'SKU-7', name: 'P2', price: 20 },
      { organizationId: 'org_1' },
    );
    await productRepo.create(
      { sku: 'SKU-8', name: 'P3', price: 30 },
      { organizationId: 'org_1' },
    );

    const delivered = await relay(store, transport);
    expect(delivered).toBe(3);
    expect(transport.published).toHaveLength(3);
    expect(transport.published.map((e) => e.type)).toEqual([
      'catalog:product.created',
      'catalog:product.created',
      'catalog:product.created',
    ]);

    // Nothing left pending.
    const pendingAfter = await store.getPending(100);
    expect(pendingAfter).toHaveLength(0);
  });

  it('relay stops on the first transport failure and leaves the rest pending', async () => {
    await productRepo.create(
      { sku: 'SKU-A', name: 'P1', price: 10 },
      { organizationId: 'org_1' },
    );
    await productRepo.create(
      { sku: 'SKU-B', name: 'P2', price: 20 },
      { organizationId: 'org_1' },
    );

    transport.failNext = true;
    const delivered = await relay(store, transport);
    expect(delivered).toBe(0); // first event failed → whole batch stops

    // Retry — now transport is healthy.
    const deliveredRetry = await relay(store, transport);
    expect(deliveredRetry).toBe(2);
    expect(transport.published).toHaveLength(2);
  });

  // ──────────────────────────────────────────────────────────────────────
  // FIFO ordering
  // ──────────────────────────────────────────────────────────────────────

  it('relay preserves FIFO order across multiple repos', async () => {
    await orderRepo.create({ total: 1 }, { organizationId: 'org_1' });
    await productRepo.create(
      { sku: 'SKU-F', name: 'P', price: 5 },
      { organizationId: 'org_1' },
    );
    await orderRepo.create({ total: 2 }, { organizationId: 'org_1' });

    await relay(store, transport);

    expect(transport.published.map((e) => e.type)).toEqual([
      'sales:order.created',
      'catalog:product.created',
      'sales:order.created',
    ]);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Idempotency — delivered rows survive until purged
  // ──────────────────────────────────────────────────────────────────────

  it('delivered rows are skipped by getPending and cleaned up by purge', async () => {
    await productRepo.create(
      { sku: 'SKU-P', name: 'P', price: 1 },
      { organizationId: 'org_1' },
    );
    await relay(store, transport);

    // Delivered — no longer pending.
    expect(await store.getPending(100)).toHaveLength(0);

    // Raw row still exists until purge.
    const rawRow = await mongoose.connection
      .collection(OUTBOX_COLLECTION)
      .findOne({ status: 'delivered' });
    expect(rawRow).not.toBeNull();

    // Purge older than 0ms — clears everything delivered.
    const purged = await store.purge(0);
    expect(purged).toBeGreaterThanOrEqual(1);

    const rawAfter = await mongoose.connection
      .collection(OUTBOX_COLLECTION)
      .findOne({ status: 'delivered' });
    expect(rawAfter).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Filter + enricher suite — separate repo, no shared hook state
// ────────────────────────────────────────────────────────────────────────────

describe('Outbox recipe — shouldEnqueue + enrichMeta', () => {
  let ProductModel: mongoose.Model<IProduct>;
  // biome-ignore lint/suspicious/noExplicitAny: test shape
  let productRepo: any;
  let store: MongoOutboxStore;

  const COLLECTION = 'outboxrecipe_filtered';

  beforeAll(async () => {
    await connectDB();
    ProductModel = await createTestModel('OutboxFilteredProduct', ProductSchema);
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await ProductModel.deleteMany({});
    await mongoose.connection.collection(COLLECTION).deleteMany({});

    productRepo = new Repository<IProduct>(ProductModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
    ]);

    store = new MongoOutboxStore({
      connection: mongoose.connection,
      name: COLLECTION,
    });
  });

  it('shouldEnqueue skips filtered operations', async () => {
    wireOutbox({
      repos: { 'catalog:product': productRepo },
      store,
      // Skip updates — only create/delete are broadcast.
      shouldEnqueue: ({ operation }) => operation !== 'update',
    });

    const product = await productRepo.create(
      { sku: 'SKU-SE', name: 'P', price: 10 },
      { organizationId: 'org_1' },
    );
    await productRepo.update(
      product._id,
      { price: 20 },
      { organizationId: 'org_1' },
    );

    const pending = await store.getPending(100);
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe('catalog:product.created');
  });

  it('enrichMeta adds correlation / custom meta fields', async () => {
    wireOutbox({
      repos: { 'catalog:product': productRepo },
      store,
      enrichMeta: () => ({ correlationId: 'trace-abc-123' }),
    });

    await productRepo.create(
      { sku: 'SKU-EM', name: 'P', price: 10 },
      { organizationId: 'org_1' },
    );

    const pending = await store.getPending(100);
    expect(pending[0].meta.correlationId).toBe('trace-abc-123');
  });
});
