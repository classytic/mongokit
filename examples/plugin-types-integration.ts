/**
 * Plugin Type Safety Integration Example
 *
 * Demonstrates how to use MongoKit plugins with full TypeScript type safety
 */

import { Schema, Types } from 'mongoose';
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
  SoftDeleteMethods,
  CacheMethods,
  WithPlugins,
} from '../src/index.js';

// ============================================================================
// Example 1: Single Plugin with Type Safety
// ============================================================================

interface IProduct {
  _id: Types.ObjectId;
  name: string;
  sku: string;
  price: number;
  stock: number;
  views: number;
  tags: string[];
}

class ProductRepo extends Repository<IProduct> {
  // Add custom business logic methods
  async findBySku(sku: string) {
    return this.getByQuery({ sku });
  }

  async isInStock(id: string): Promise<boolean> {
    const product = await this.getById(id);
    return product ? product.stock > 0 : false;
  }
}

// Type helper for MongoDB operations
type ProductRepoWithMongo = ProductRepo & MongoOperationsMethods<IProduct>;

async function exampleSinglePlugin() {
  // Assuming ProductModel is defined elsewhere
  const ProductModel = {} as any; // placeholder

  const productRepo = new ProductRepo(ProductModel, [
    methodRegistryPlugin(),
    mongoOperationsPlugin(),
  ]) as ProductRepoWithMongo;

  // ✅ TypeScript provides autocomplete for:
  // - Base Repository methods (create, getById, update, etc.)
  // - Custom methods (findBySku, isInStock)
  // - MongoDB operations (increment, upsert, pushToArray, etc.)

  const product = await productRepo.create({
    name: 'Widget',
    sku: 'WIDGET-001',
    price: 99.99,
    stock: 100,
    views: 0,
    tags: [],
  });

  // MongoDB operations with type safety
  await productRepo.increment(product._id.toString(), 'views', 1);
  await productRepo.pushToArray(product._id.toString(), 'tags', 'featured');
  await productRepo.upsert({ sku: 'WIDGET-002' }, { name: 'Widget 2', price: 49.99 });

  // Custom methods work too
  const foundProduct = await productRepo.findBySku('WIDGET-001');
  const inStock = await productRepo.isInStock(product._id.toString());

  return { product, foundProduct, inStock };
}

// ============================================================================
// Example 2: Multiple Plugins with Type Safety
// ============================================================================

interface IOrder {
  _id: Types.ObjectId;
  customerId: string;
  items: Array<{
    _id: Types.ObjectId;
    productId: string;
    quantity: number;
    price: number;
  }>;
  total: number;
  status: 'pending' | 'processing' | 'completed' | 'cancelled';
  createdAt: Date;
}

class OrderRepo extends Repository<IOrder> {
  // Custom business logic
  async getCustomerOrders(customerId: string) {
    return this.getAll({ filters: { customerId } });
  }

  async calculateOrderTotal(orderId: string): Promise<number> {
    const order = await this.getById(orderId);
    if (!order) return 0;
    return order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }
}

// Combine multiple plugin type interfaces
type OrderRepoWithPlugins = OrderRepo &
  MongoOperationsMethods<IOrder> &
  BatchOperationsMethods &
  AggregateHelpersMethods &
  SubdocumentMethods<IOrder>;

async function exampleMultiplePlugins() {
  const OrderModel = {} as any; // placeholder

  const orderRepo = new OrderRepo(OrderModel, [
    methodRegistryPlugin(),
    mongoOperationsPlugin(),
    batchOperationsPlugin(),
    aggregateHelpersPlugin(),
    subdocumentPlugin(),
  ]) as OrderRepoWithPlugins;

  // ✅ TypeScript knows about ALL plugin methods!

  // Create an order
  const order = await orderRepo.create({
    customerId: 'CUST-001',
    items: [],
    total: 0,
    status: 'pending',
    createdAt: new Date(),
  });

  // Subdocument operations
  await orderRepo.addSubdocument(order._id.toString(), 'items', {
    productId: 'PROD-001',
    quantity: 2,
    price: 99.99,
  });

  // MongoDB operations
  await orderRepo.setField(order._id.toString(), 'status', 'processing');
  await orderRepo.increment(order._id.toString(), 'total', 199.98);

  // Batch operations
  await orderRepo.updateMany(
    { status: 'pending' },
    { status: 'cancelled' }
  );
  await orderRepo.deleteMany({ status: 'cancelled', createdAt: { $lt: new Date('2024-01-01') } });

  // Aggregate helpers
  const totalRevenue = await orderRepo.sum('total', { status: 'completed' });
  const avgOrderValue = await orderRepo.average('total');
  const statusGroups = await orderRepo.groupBy('status');

  // Custom methods
  const customerOrders = await orderRepo.getCustomerOrders('CUST-001');
  const orderTotal = await orderRepo.calculateOrderTotal(order._id.toString());

  return {
    order,
    totalRevenue,
    avgOrderValue,
    statusGroups,
    customerOrders,
    orderTotal,
  };
}

// ============================================================================
// Example 3: Flexible Repository (No Type Annotations)
// ============================================================================

// For quick prototyping or when you don't need autocomplete
async function exampleFlexibleRepo() {
  const ProductModel = {} as any; // placeholder

  const flexibleRepo = new Repository(ProductModel, [
    methodRegistryPlugin(),
    mongoOperationsPlugin(),
  ]);

  // Works at runtime but no TypeScript autocomplete
  const product = await flexibleRepo.create({ name: 'Test', price: 99 });

  // Need to use 'as any' to access plugin methods without type errors
  await (flexibleRepo as any).increment(product._id.toString(), 'views', 1);
  await (flexibleRepo as any).upsert({ sku: 'TEST' }, { name: 'Test' });

  return product;
}

// ============================================================================
// Example 4: Type-Safe Repository Factory
// ============================================================================

// Helper function to create repositories with consistent plugin setup
function createTypedRepository<
  TDoc,
  TRepo extends Repository<TDoc>,
  TPluginMethods = unknown
>(
  RepoClass: new (...args: any[]) => TRepo,
  Model: any,
  plugins: any[]
): TRepo & TPluginMethods {
  return new RepoClass(Model, plugins) as TRepo & TPluginMethods;
}

async function exampleRepositoryFactory() {
  const ProductModel = {} as any; // placeholder

  // Type-safe factory usage
  const productRepo = createTypedRepository<
    IProduct,
    ProductRepo,
    MongoOperationsMethods<IProduct>
  >(
    ProductRepo,
    ProductModel,
    [methodRegistryPlugin(), mongoOperationsPlugin()]
  );

  // Full type safety!
  await productRepo.increment('id', 'views', 1);
  await productRepo.findBySku('TEST-001');

  return productRepo;
}

// ============================================================================
// Example 5: Complete Plugin Stack with Type Safety
// ============================================================================

interface IDocument {
  _id: Types.ObjectId;
  name: string;
  status: string;
  views: number;
  deletedAt?: Date | null;
  deletedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

class DocumentRepo extends Repository<IDocument> {
  async findByStatus(status: string) {
    return this.getAll({ filters: { status } });
  }
}

async function exampleCompletePluginStack() {
  const DocumentModel = {} as any; // placeholder
  const cacheAdapter = {} as any; // placeholder

  // ✨ Clean syntax with WithPlugins helper
  const docRepo = new DocumentRepo(DocumentModel, [
    methodRegistryPlugin(),
    mongoOperationsPlugin(),
    batchOperationsPlugin(),
    aggregateHelpersPlugin(),
    subdocumentPlugin(),
    softDeletePlugin({ deletedField: 'deletedAt' }),
    cachePlugin({ adapter: cacheAdapter, ttl: 60 }),
  ]) as WithPlugins<IDocument, DocumentRepo>;

  // TypeScript provides autocomplete for ALL plugin methods + custom methods!

  // Create document
  const doc = await docRepo.create({
    name: 'Important Doc',
    status: 'active',
    views: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // MongoOperationsMethods
  await docRepo.increment(doc._id.toString(), 'views', 1);
  await docRepo.setField(doc._id.toString(), 'status', 'published');

  // BatchOperationsMethods
  await docRepo.updateMany({ status: 'draft' }, { status: 'archived' });

  // AggregateHelpersMethods
  const totalViews = await docRepo.sum('views', { status: 'published' });
  const avgViews = await docRepo.average('views');

  // SoftDeleteMethods
  await docRepo.delete(doc._id.toString()); // Soft delete
  const deletedDocs = await docRepo.getDeleted({ page: 1, limit: 10 });
  await docRepo.restore(doc._id.toString()); // Restore

  // CacheMethods
  await docRepo.invalidateCache(doc._id.toString());
  await docRepo.invalidateListCache();
  const cacheStats = docRepo.getCacheStats();

  // Custom methods
  const activeDocs = await docRepo.findByStatus('active');

  return {
    doc,
    totalViews,
    avgViews,
    deletedDocs,
    cacheStats,
    activeDocs,
  };
}

// ============================================================================
// Export Examples
// ============================================================================

export {
  exampleSinglePlugin,
  exampleMultiplePlugins,
  exampleFlexibleRepo,
  exampleRepositoryFactory,
  exampleCompletePluginStack,
};
