/**
 * Plugin Type Safety Integration Tests
 *
 * Comprehensive tests for all plugin type interfaces with complex real-world scenarios
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import {
  Repository,
  methodRegistryPlugin,
  mongoOperationsPlugin,
  batchOperationsPlugin,
  aggregateHelpersPlugin,
  subdocumentPlugin,
} from '../src/index.js';
import type {
  MongoOperationsMethods,
  BatchOperationsMethods,
  AggregateHelpersMethods,
  SubdocumentMethods,
} from '../src/index.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

describe('Plugin Type Safety - Integration Tests', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  // ============================================================================
  // BatchOperationsMethods Tests
  // ============================================================================

  describe('BatchOperationsMethods', () => {
    interface IBatchTest {
      _id: Types.ObjectId;
      status: 'active' | 'inactive' | 'archived';
      priority: number;
      tags: string[];
      processedAt?: Date;
    }

    const BatchTestSchema = new Schema<IBatchTest>({
      status: { type: String, required: true },
      priority: { type: Number, default: 0 },
      tags: [String],
      processedAt: Date,
    });

    let BatchTestModel: mongoose.Model<IBatchTest>;

    class BatchTestRepo extends Repository<IBatchTest> {}
    type BatchRepoWithTypes = BatchTestRepo & BatchOperationsMethods;

    let repo: BatchRepoWithTypes;

    beforeAll(async () => {
      BatchTestModel = await createTestModel('BatchTest', BatchTestSchema);
      repo = new BatchTestRepo(BatchTestModel, [
        methodRegistryPlugin(),
        batchOperationsPlugin(),
      ]) as BatchRepoWithTypes;
    });

    beforeEach(async () => {
      await BatchTestModel.deleteMany({});
    });

    afterAll(async () => {
      await BatchTestModel.deleteMany({});
    });

    it('should update many documents with type safety', async () => {
      // Create test data
      await repo.createMany([
        { status: 'active', priority: 1, tags: [] },
        { status: 'active', priority: 2, tags: [] },
        { status: 'inactive', priority: 3, tags: [] },
        { status: 'active', priority: 4, tags: [] },
      ]);

      // Update all active to archived
      const result = await repo.updateMany(
        { status: 'active' },
        { status: 'archived', processedAt: new Date() }
      );

      expect(result.matchedCount).toBe(3);
      expect(result.modifiedCount).toBe(3);

      // Verify changes
      const archived = await repo.getAll({ filters: { status: 'archived' } });
      expect(archived.docs).toHaveLength(3);
      archived.docs.forEach(doc => {
        expect(doc.processedAt).toBeDefined();
      });
    });

    it('should delete many documents with type safety', async () => {
      // Create test data
      await repo.createMany([
        { status: 'archived', priority: 1, tags: [] },
        { status: 'archived', priority: 2, tags: [] },
        { status: 'active', priority: 3, tags: [] },
        { status: 'archived', priority: 4, tags: [] },
      ]);

      // Delete all archived
      const result = await repo.deleteMany({ status: 'archived' });

      expect(result.deletedCount).toBe(3);

      // Verify only active remains
      const remaining = await repo.count({});
      expect(remaining).toBe(1);
    });

    it('should handle complex batch updates', async () => {
      await repo.createMany([
        { status: 'active', priority: 1, tags: ['urgent'] },
        { status: 'active', priority: 5, tags: ['normal'] },
        { status: 'inactive', priority: 3, tags: [] },
      ]);

      // Update high priority items
      await repo.updateMany(
        { priority: { $gte: 5 } },
        { status: 'inactive' }
      );

      const highPriorityInactive = await repo.count({
        priority: { $gte: 5 },
        status: 'inactive',
      });
      expect(highPriorityInactive).toBe(1);
    });
  });

  // ============================================================================
  // AggregateHelpersMethods Tests
  // ============================================================================

  describe('AggregateHelpersMethods', () => {
    interface IAggregateTest {
      _id: Types.ObjectId;
      category: string;
      amount: number;
      quantity: number;
      status: 'pending' | 'completed' | 'failed';
      createdAt: Date;
    }

    const AggregateTestSchema = new Schema<IAggregateTest>({
      category: { type: String, required: true },
      amount: { type: Number, required: true },
      quantity: { type: Number, required: true },
      status: { type: String, required: true },
      createdAt: { type: Date, default: Date.now },
    });

    let AggregateTestModel: mongoose.Model<IAggregateTest>;

    class AggregateTestRepo extends Repository<IAggregateTest> {}
    type AggregateRepoWithTypes = AggregateTestRepo & AggregateHelpersMethods;

    let repo: AggregateRepoWithTypes;

    beforeAll(async () => {
      AggregateTestModel = await createTestModel('AggregateTest', AggregateTestSchema);
      repo = new AggregateTestRepo(AggregateTestModel, [
        methodRegistryPlugin(),
        aggregateHelpersPlugin(),
      ]) as AggregateRepoWithTypes;
    });

    beforeEach(async () => {
      await AggregateTestModel.deleteMany({});
    });

    afterAll(async () => {
      await AggregateTestModel.deleteMany({});
    });

    it('should group by category with type safety', async () => {
      await repo.createMany([
        { category: 'electronics', amount: 100, quantity: 1, status: 'completed' },
        { category: 'electronics', amount: 200, quantity: 2, status: 'completed' },
        { category: 'books', amount: 50, quantity: 3, status: 'completed' },
        { category: 'electronics', amount: 150, quantity: 1, status: 'pending' },
        { category: 'books', amount: 75, quantity: 2, status: 'completed' },
      ]);

      const groups = await repo.groupBy('category');

      expect(groups).toHaveLength(2);

      const electronicsGroup = groups.find(g => g._id === 'electronics');
      const booksGroup = groups.find(g => g._id === 'books');

      expect(electronicsGroup?.count).toBe(3);
      expect(booksGroup?.count).toBe(2);
    });

    it('should calculate sum with filters', async () => {
      await repo.createMany([
        { category: 'electronics', amount: 100, quantity: 1, status: 'completed' },
        { category: 'electronics', amount: 200, quantity: 2, status: 'completed' },
        { category: 'electronics', amount: 150, quantity: 1, status: 'pending' },
        { category: 'books', amount: 50, quantity: 3, status: 'completed' },
      ]);

      // Sum only completed electronics
      const total = await repo.sum('amount', {
        category: 'electronics',
        status: 'completed',
      });

      expect(total).toBe(300);
    });

    it('should calculate average with type safety', async () => {
      await repo.createMany([
        { category: 'electronics', amount: 100, quantity: 5, status: 'completed' },
        { category: 'electronics', amount: 200, quantity: 10, status: 'completed' },
        { category: 'electronics', amount: 300, quantity: 15, status: 'completed' },
      ]);

      const avgAmount = await repo.average('amount');
      expect(avgAmount).toBe(200);

      const avgQuantity = await repo.average('quantity', { category: 'electronics' });
      expect(avgQuantity).toBe(10);
    });

    it('should get min and max values', async () => {
      await repo.createMany([
        { category: 'test', amount: 50, quantity: 1, status: 'completed' },
        { category: 'test', amount: 150, quantity: 2, status: 'completed' },
        { category: 'test', amount: 100, quantity: 3, status: 'completed' },
      ]);

      const minAmount = await repo.min('amount');
      const maxAmount = await repo.max('amount');

      expect(minAmount).toBe(50);
      expect(maxAmount).toBe(150);
    });

    it('should handle complex aggregations', async () => {
      await repo.createMany([
        { category: 'A', amount: 100, quantity: 5, status: 'completed' },
        { category: 'A', amount: 200, quantity: 3, status: 'pending' },
        { category: 'B', amount: 150, quantity: 7, status: 'completed' },
        { category: 'B', amount: 50, quantity: 2, status: 'failed' },
        { category: 'A', amount: 300, quantity: 4, status: 'completed' },
      ]);

      // Group by category with limit
      const topCategories = await repo.groupBy('category', { limit: 1 });
      expect(topCategories).toHaveLength(1);
      expect(topCategories[0]._id).toBe('A'); // Has 3 documents

      // Sum for specific status
      const completedTotal = await repo.sum('amount', { status: 'completed' });
      expect(completedTotal).toBe(550); // 100 + 300 + 150

      // Average for category
      const avgCategoryA = await repo.average('quantity', { category: 'A' });
      expect(avgCategoryA).toBe(4); // (5 + 3 + 4) / 3
    });
  });

  // ============================================================================
  // SubdocumentMethods Tests with Complex Scenarios
  // ============================================================================

  describe('SubdocumentMethods - Complex Scenarios', () => {
    interface IOrderItem {
      _id: Types.ObjectId;
      productId: string;
      productName: string;
      quantity: number;
      price: number;
      discountPercent: number;
      metadata?: Record<string, unknown>;
    }

    interface IShippingAddress {
      _id: Types.ObjectId;
      street: string;
      city: string;
      state: string;
      zip: string;
      isDefault: boolean;
    }

    interface IOrder {
      _id: Types.ObjectId;
      orderNumber: string;
      customerId: string;
      items: IOrderItem[];
      shippingAddresses: IShippingAddress[];
      subtotal: number;
      tax: number;
      total: number;
      status: 'pending' | 'processing' | 'shipped' | 'delivered';
      notes: string[];
      createdAt: Date;
      updatedAt?: Date;
    }

    const OrderSchema = new Schema<IOrder>({
      orderNumber: { type: String, required: true, unique: true },
      customerId: { type: String, required: true },
      items: [{
        productId: { type: String, required: true },
        productName: { type: String, required: true },
        quantity: { type: Number, required: true },
        price: { type: Number, required: true },
        discountPercent: { type: Number, default: 0 },
        metadata: Schema.Types.Mixed,
      }],
      shippingAddresses: [{
        street: { type: String, required: true },
        city: { type: String, required: true },
        state: { type: String, required: true },
        zip: { type: String, required: true },
        isDefault: { type: Boolean, default: false },
      }],
      subtotal: { type: Number, default: 0 },
      tax: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      status: { type: String, default: 'pending' },
      notes: [String],
      createdAt: { type: Date, default: Date.now },
      updatedAt: Date,
    });

    let OrderModel: mongoose.Model<IOrder>;

    class OrderRepo extends Repository<IOrder> {
      // Custom business logic
      async recalculateTotal(orderId: string) {
        const order = await this.getById(orderId);
        if (!order) throw new Error('Order not found');

        const subtotal = order.items.reduce((sum, item) => {
          const itemTotal = item.price * item.quantity;
          const discount = (itemTotal * item.discountPercent) / 100;
          return sum + (itemTotal - discount);
        }, 0);

        const tax = subtotal * 0.08; // 8% tax
        const total = subtotal + tax;

        return this.update(orderId, { subtotal, tax, total, updatedAt: new Date() });
      }
    }

    type OrderRepoWithPlugins = OrderRepo &
      MongoOperationsMethods<IOrder> &
      SubdocumentMethods<IOrder>;

    let repo: OrderRepoWithPlugins;

    beforeAll(async () => {
      OrderModel = await createTestModel('OrderIntegrationTest', OrderSchema);
      repo = new OrderRepo(OrderModel, [
        methodRegistryPlugin(),
        mongoOperationsPlugin(),
        subdocumentPlugin(),
      ]) as OrderRepoWithPlugins;
    });

    beforeEach(async () => {
      await OrderModel.deleteMany({});
    });

    afterAll(async () => {
      await OrderModel.deleteMany({});
    });

    it('should handle complex subdocument operations on order items', async () => {
      // Create order
      const order = await repo.create({
        orderNumber: 'ORD-001',
        customerId: 'CUST-001',
        items: [],
        shippingAddresses: [],
        subtotal: 0,
        tax: 0,
        total: 0,
        status: 'pending',
        notes: [],
        createdAt: new Date(),
      });

      // Add first item
      const withItem1 = await repo.addSubdocument(order._id.toString(), 'items', {
        productId: 'PROD-001',
        productName: 'Widget A',
        quantity: 2,
        price: 99.99,
        discountPercent: 10,
        metadata: { sku: 'WID-A-001', warehouse: 'WH1' },
      });

      expect(withItem1.items).toHaveLength(1);
      expect(withItem1.items[0].productName).toBe('Widget A');
      expect(withItem1.items[0].metadata).toEqual({ sku: 'WID-A-001', warehouse: 'WH1' });

      // Add second item
      const withItem2 = await repo.addSubdocument(order._id.toString(), 'items', {
        productId: 'PROD-002',
        productName: 'Widget B',
        quantity: 1,
        price: 149.99,
        discountPercent: 0,
      });

      expect(withItem2.items).toHaveLength(2);

      // Get specific item
      const item1 = await repo.getSubdocument(
        order._id.toString(),
        'items',
        withItem1.items[0]._id.toString()
      );

      expect(item1.productName).toBe('Widget A');
      expect(item1.quantity).toBe(2);

      // Update item quantity and price
      const updatedOrder = await repo.updateSubdocument(
        order._id.toString(),
        'items',
        withItem1.items[0]._id.toString(),
        {
          productId: 'PROD-001', // Required field
          productName: 'Widget A', // Required field
          quantity: 5,
          price: 89.99,
          discountPercent: 15,
        }
      );

      expect(updatedOrder.items).toHaveLength(2);
      const updatedItem = updatedOrder.items.find(
        i => i._id.toString() === withItem1.items[0]._id.toString()
      );
      expect(updatedItem?.quantity).toBe(5);
      expect(updatedItem?.price).toBe(89.99);

      // Recalculate totals using custom method
      const withTotals = await repo.recalculateTotal(order._id.toString());
      expect(withTotals.subtotal).toBeGreaterThan(0);
      expect(withTotals.tax).toBeGreaterThan(0);
      expect(withTotals.total).toBe(withTotals.subtotal + withTotals.tax);

      // Remove item
      const afterDelete = await repo.deleteSubdocument(
        order._id.toString(),
        'items',
        withItem2.items[1]._id.toString()
      );

      expect(afterDelete.items).toHaveLength(1);
    });

    it('should manage multiple shipping addresses', async () => {
      const order = await repo.create({
        orderNumber: 'ORD-002',
        customerId: 'CUST-002',
        items: [],
        shippingAddresses: [],
        subtotal: 0,
        tax: 0,
        total: 0,
        status: 'pending',
        notes: [],
        createdAt: new Date(),
      });

      // Add home address (default)
      const withHome = await repo.addSubdocument(order._id.toString(), 'shippingAddresses', {
        street: '123 Main St',
        city: 'Anytown',
        state: 'CA',
        zip: '12345',
        isDefault: true,
      });

      // Add work address
      const withWork = await repo.addSubdocument(order._id.toString(), 'shippingAddresses', {
        street: '456 Business Ave',
        city: 'Workville',
        state: 'NY',
        zip: '67890',
        isDefault: false,
      });

      expect(withWork.shippingAddresses).toHaveLength(2);

      // Get default address
      const homeAddress = await repo.getSubdocument(
        order._id.toString(),
        'shippingAddresses',
        withHome.shippingAddresses[0]._id.toString(),
        { lean: true }
      );

      expect(homeAddress.isDefault).toBe(true);
      expect(homeAddress.city).toBe('Anytown');

      // Update work address to be default
      await repo.updateSubdocument(
        order._id.toString(),
        'shippingAddresses',
        withWork.shippingAddresses[1]._id.toString(),
        {
          street: '456 Business Blvd',
          city: 'Workville', // Required field
          state: 'NY', // Required field
          zip: '67890', // Required field
          isDefault: true,
        }
      );

      // Verify update
      const updated = await repo.getById(order._id.toString());
      const workAddr = updated!.shippingAddresses.find(
        a => a._id.toString() === withWork.shippingAddresses[1]._id.toString()
      );
      expect(workAddr?.isDefault).toBe(true);
      expect(workAddr?.street).toBe('456 Business Blvd');
    });

    it('should combine subdocument operations with MongoDB operations', async () => {
      const order = await repo.create({
        orderNumber: 'ORD-003',
        customerId: 'CUST-003',
        items: [],
        shippingAddresses: [],
        subtotal: 0,
        tax: 0,
        total: 0,
        status: 'pending',
        notes: [],
        createdAt: new Date(),
      });

      // Add item using subdocument
      await repo.addSubdocument(order._id.toString(), 'items', {
        productId: 'PROD-001',
        productName: 'Test Product',
        quantity: 1,
        price: 100,
        discountPercent: 0,
      });

      // Add note using MongoDB pushToArray
      await repo.pushToArray(order._id.toString(), 'notes', 'Customer requested gift wrap');
      await repo.pushToArray(order._id.toString(), 'notes', 'Fragile items - handle with care');

      // Update status using setField
      await repo.setField(order._id.toString(), 'status', 'processing');

      // Set totals using MongoDB operations
      await repo.setField(order._id.toString(), 'subtotal', 100);
      await repo.setField(order._id.toString(), 'tax', 8);
      await repo.setField(order._id.toString(), 'total', 108);

      // Verify all changes
      const final = await repo.getById(order._id.toString());
      expect(final!.items).toHaveLength(1);
      expect(final!.notes).toHaveLength(2);
      expect(final!.status).toBe('processing');
      expect(final!.total).toBe(108);
    });

    it('should handle edge cases with subdocuments', async () => {
      const order = await repo.create({
        orderNumber: 'ORD-004',
        customerId: 'CUST-004',
        items: [],
        shippingAddresses: [],
        subtotal: 0,
        tax: 0,
        total: 0,
        status: 'pending',
        notes: [],
        createdAt: new Date(),
      });

      // Add item with minimal data
      const withItem = await repo.addSubdocument(order._id.toString(), 'items', {
        productId: 'PROD-MIN',
        productName: 'Minimal Product',
        quantity: 1,
        price: 1,
        discountPercent: 0,
      });

      const itemId = withItem.items[0]._id.toString();

      // Try to get non-existent subdocument (should throw)
      await expect(
        repo.getSubdocument(
          order._id.toString(),
          'items',
          new Types.ObjectId().toString()
        )
      ).rejects.toThrow();

      // Update with all fields
      await repo.updateSubdocument(order._id.toString(), 'items', itemId, {
        productId: 'PROD-UPD',
        productName: 'Updated Product',
        quantity: 10,
        price: 99.99,
        discountPercent: 20,
        metadata: { updated: true, timestamp: new Date().toISOString() },
      });

      const updated = await repo.getSubdocument(order._id.toString(), 'items', itemId);
      expect(updated.quantity).toBe(10);
      expect(updated.metadata).toHaveProperty('updated', true);
    });
  });

  // ============================================================================
  // Combined Plugin Tests - Real-World E-commerce Scenario
  // ============================================================================

  describe('All Plugins Combined - E-commerce Scenario', () => {
    interface IProduct {
      _id: Types.ObjectId;
      sku: string;
      name: string;
      price: number;
      stock: number;
      views: number;
      sales: number;
      category: string;
      tags: string[];
      reviews: Array<{
        _id: Types.ObjectId;
        userId: string;
        rating: number;
        comment: string;
        helpful: number;
        createdAt: Date;
      }>;
      status: 'active' | 'discontinued' | 'out-of-stock';
      createdAt: Date;
    }

    const ProductSchema = new Schema<IProduct>({
      sku: { type: String, required: true, unique: true },
      name: { type: String, required: true },
      price: { type: Number, required: true },
      stock: { type: Number, default: 0 },
      views: { type: Number, default: 0 },
      sales: { type: Number, default: 0 },
      category: { type: String, required: true },
      tags: [String],
      reviews: [{
        userId: { type: String, required: true },
        rating: { type: Number, required: true, min: 1, max: 5 },
        comment: String,
        helpful: { type: Number, default: 0 },
        createdAt: { type: Date, default: Date.now },
      }],
      status: { type: String, default: 'active' },
      createdAt: { type: Date, default: Date.now },
    });

    let ProductModel: mongoose.Model<IProduct>;

    class ProductRepo extends Repository<IProduct> {
      async sellProduct(sku: string, quantity: number) {
        const product = await this.getByQuery({ sku });
        if (!product) throw new Error('Product not found');
        if (product.stock < quantity) throw new Error('Insufficient stock');

        // Decrement stock, increment sales
        const updated = await (this as any).update(product._id.toString(), {
          $inc: { stock: -quantity, sales: quantity },
        });

        // Mark as out of stock if needed
        if (updated.stock === 0) {
          await (this as any).setField(updated._id.toString(), 'status', 'out-of-stock');
        }

        return updated;
      }

      async getTopRatedProducts(minRating: number, limit: number = 10) {
        const products = await this.getAll({ filters: { status: 'active' }, limit });
        return products.docs.filter(p => {
          if (!p.reviews.length) return false;
          const avgRating = p.reviews.reduce((sum, r) => sum + r.rating, 0) / p.reviews.length;
          return avgRating >= minRating;
        });
      }
    }

    type ProductRepoComplete = ProductRepo &
      MongoOperationsMethods<IProduct> &
      BatchOperationsMethods &
      AggregateHelpersMethods &
      SubdocumentMethods<IProduct>;

    let repo: ProductRepoComplete;

    beforeAll(async () => {
      ProductModel = await createTestModel('ProductComplete', ProductSchema);
      repo = new ProductRepo(ProductModel, [
        methodRegistryPlugin(),
        mongoOperationsPlugin(),
        batchOperationsPlugin(),
        aggregateHelpersPlugin(),
        subdocumentPlugin(),
      ]) as ProductRepoComplete;
    });

    beforeEach(async () => {
      await ProductModel.deleteMany({});
    });

    afterAll(async () => {
      await ProductModel.deleteMany({});
    });

    it('should handle complete e-commerce workflow', async () => {
      // 1. Create products
      const products = await repo.createMany([
        {
          sku: 'WIDGET-001',
          name: 'Super Widget',
          price: 99.99,
          stock: 100,
          category: 'widgets',
          tags: ['featured', 'bestseller'],
          reviews: [],
          views: 0,
          sales: 0,
          status: 'active',
          createdAt: new Date(),
        },
        {
          sku: 'GADGET-001',
          name: 'Amazing Gadget',
          price: 149.99,
          stock: 50,
          category: 'gadgets',
          tags: ['new'],
          reviews: [],
          views: 0,
          sales: 0,
          status: 'active',
          createdAt: new Date(),
        },
        {
          sku: 'TOOL-001',
          name: 'Pro Tool',
          price: 199.99,
          stock: 25,
          category: 'tools',
          tags: [],
          reviews: [],
          views: 0,
          sales: 0,
          status: 'active',
          createdAt: new Date(),
        },
      ]);

      // 2. Track views (MongoOperationsMethods)
      await repo.increment(products[0]._id.toString(), 'views', 10);
      await repo.increment(products[1]._id.toString(), 'views', 5);

      // 3. Add reviews (SubdocumentMethods)
      await repo.addSubdocument(products[0]._id.toString(), 'reviews', {
        userId: 'USER-001',
        rating: 5,
        comment: 'Excellent product!',
        helpful: 0,
        createdAt: new Date(),
      });

      await repo.addSubdocument(products[0]._id.toString(), 'reviews', {
        userId: 'USER-002',
        rating: 4,
        comment: 'Good value for money',
        helpful: 0,
        createdAt: new Date(),
      });

      // 4. Sell products (custom method + MongoOperations)
      await repo.sellProduct('WIDGET-001', 30);

      // 5. Add promotional tags (MongoOperationsMethods)
      await repo.pushToArray(products[0]._id.toString(), 'tags', 'sale');
      await repo.addToSet(products[1]._id.toString(), 'tags', 'featured');

      // 6. Update prices for category (BatchOperationsMethods)
      await repo.updateMany(
        { category: 'widgets' },
        { $mul: { price: 0.9 } } // 10% off
      );

      // 7. Discontinue out-of-stock items
      await repo.updateMany(
        { stock: 0 },
        { status: 'discontinued' }
      );

      // 8. Calculate analytics (AggregateHelpersMethods)
      const totalSales = await repo.sum('sales');
      const avgPrice = await repo.average('price', { status: 'active' });
      const categoryGroups = await repo.groupBy('category');
      const maxStock = await repo.max('stock');

      // 9. Verify results
      const widget = await repo.getByQuery({ sku: 'WIDGET-001' });
      expect(widget!.views).toBe(10);
      expect(widget!.sales).toBe(30);
      expect(widget!.stock).toBe(70);
      expect(widget!.reviews).toHaveLength(2);
      expect(widget!.tags).toContain('sale');
      expect(widget!.price).toBeLessThan(99.99); // After 10% discount

      expect(totalSales).toBe(30);
      expect(avgPrice).toBeGreaterThan(0);
      expect(categoryGroups.length).toBeGreaterThanOrEqual(2);
      expect(maxStock).toBe(70); // WIDGET-001 after selling 30

      // 10. Get top rated products (custom method)
      const topRated = await repo.getTopRatedProducts(4, 10);
      expect(topRated.length).toBeGreaterThan(0);
      expect(topRated[0].sku).toBe('WIDGET-001');
    });
  });
});
