/**
 * Base Controller Tests
 *
 * Tests the framework-agnostic BaseController that implements IController
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Model } from 'mongoose';
import {
  type IRequestContext,
  type IControllerResponse,
  type PaginationResult,
} from '../src/types.js';
import { BaseController, type RouteSchemaOptions } from '../examples/api/BaseController.js';

// ============================================================================
// Test Schema & Model
// ============================================================================

interface IProduct {
  _id: string;
  name: string;
  description: string;
  price: number;
  status: 'draft' | 'published' | 'archived';
  featured: boolean;
  role: string; // system-managed field
  credits: number; // system-managed field
  organizationId?: string;
  categoryId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<IProduct>({
  name: { type: String, required: true },
  description: { type: String, required: true },
  price: { type: Number, required: true },
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft' },
  featured: { type: Boolean, default: false },
  role: { type: String, default: 'user' },
  credits: { type: Number, default: 0 },
  organizationId: { type: String },
  categoryId: { type: String },
}, {
  timestamps: true,
});

let ProductModel: Model<IProduct>;

// ============================================================================
// Test Controllers
// ============================================================================

/**
 * Basic controller with field protection
 */
class ProductController extends BaseController<IProduct> {
  constructor(model: Model<IProduct>, options: RouteSchemaOptions = {}) {
    super(model, {
      fieldRules: {
        role: { systemManaged: true },
        credits: { systemManaged: true },
      },
      query: {
        allowedLookups: ['categories', 'tags'],
        allowedLookupFields: {
          categories: {
            localFields: ['categoryId'],
            foreignFields: ['_id', 'name'],
          },
        },
      },
      ...options,
    });
  }
}

/**
 * Extended controller with custom logic
 */
class ExtendedProductController extends ProductController {
  async create(context: IRequestContext): Promise<IControllerResponse<IProduct>> {
    // Custom validation
    const { price } = context.body as { price?: number };

    if (price && price < 0) {
      return {
        success: false,
        error: 'Price cannot be negative',
        status: 400,
      };
    }

    // Call parent
    return super.create(context);
  }

  // Custom method
  async getFeatured(context: IRequestContext): Promise<IControllerResponse<PaginationResult<IProduct>>> {
    const modifiedContext: IRequestContext = {
      ...context,
      query: {
        ...context.query,
        featured: true, // QueryParser expects filters directly
      },
    };

    return this.list(modifiedContext);
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('BaseController - Framework-Agnostic CRUD', () => {
  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/mongokit-test-base-controller');
    ProductModel = mongoose.model('Product', productSchema);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await ProductModel.deleteMany({});
  });

  describe('Basic CRUD Operations', () => {
    it('should create a new product', async () => {
      const controller = new ProductController(ProductModel);

      const context: IRequestContext = {
        query: {},
        body: {
          name: 'Test Product',
          description: 'A test product',
          price: 99.99,
          status: 'draft',
        },
        params: {},
      };

      const response = await controller.create(context);

      expect(response.success).toBe(true);
      expect(response.status).toBe(201);
      expect(response.data).toBeDefined();
      expect(response.data!.name).toBe('Test Product');
      expect(response.data!.price).toBe(99.99);
    });

    it('should list products with pagination', async () => {
      const controller = new ProductController(ProductModel);

      // Create test data
      await ProductModel.create([
        { name: 'Product 1', description: 'Desc 1', price: 10 },
        { name: 'Product 2', description: 'Desc 2', price: 20 },
        { name: 'Product 3', description: 'Desc 3', price: 30 },
      ]);

      const context: IRequestContext = {
        query: { page: 1, limit: 2 },
        body: {},
        params: {},
      };

      const response = await controller.list(context);

      expect(response.success).toBe(true);
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      expect((response.data as PaginationResult<IProduct>).docs).toHaveLength(2);
      expect((response.data as PaginationResult<IProduct>).total).toBe(3);
    });

    it('should get product by ID', async () => {
      const controller = new ProductController(ProductModel);

      const product = await ProductModel.create({
        name: 'Get Test',
        description: 'Get test product',
        price: 50,
      });

      const context: IRequestContext = {
        query: {},
        body: {},
        params: { id: product._id.toString() },
      };

      const response = await controller.get(context);

      expect(response.success).toBe(true);
      expect(response.status).toBe(200);
      expect(response.data).toBeDefined();
      expect(response.data!.name).toBe('Get Test');
    });

    it('should return 404 for non-existent product', async () => {
      const controller = new ProductController(ProductModel);

      const context: IRequestContext = {
        query: {},
        body: {},
        params: { id: new mongoose.Types.ObjectId().toString() },
      };

      const response = await controller.get(context);

      expect(response.success).toBe(false);
      expect(response.status).toBe(404);
      expect(response.error).toBe('Resource not found');
    });

    it('should update a product', async () => {
      const controller = new ProductController(ProductModel);

      const product = await ProductModel.create({
        name: 'Update Test',
        description: 'Will be updated',
        price: 75,
      });

      const context: IRequestContext = {
        query: {},
        body: {
          name: 'Updated Product',
          price: 100,
        },
        params: { id: product._id.toString() },
      };

      const response = await controller.update(context);

      expect(response.success).toBe(true);
      expect(response.status).toBe(200);
      expect(response.data!.name).toBe('Updated Product');
      expect(response.data!.price).toBe(100);
    });

    it('should delete a product', async () => {
      const controller = new ProductController(ProductModel);

      const product = await ProductModel.create({
        name: 'Delete Test',
        description: 'Will be deleted',
        price: 25,
      });

      const context: IRequestContext = {
        query: {},
        body: {},
        params: { id: product._id.toString() },
      };

      const response = await controller.delete(context);

      expect(response.success).toBe(true);
      expect(response.status).toBe(200);
      expect(response.data!.message).toContain('Deleted');

      // Verify deletion
      const found = await ProductModel.findById(product._id);
      expect(found).toBeNull();
    });
  });

  describe('System-Managed Field Protection', () => {
    it('should block system-managed fields on create', async () => {
      const controller = new ProductController(ProductModel);

      const context: IRequestContext = {
        query: {},
        body: {
          name: 'Security Test',
          description: 'Testing field protection',
          price: 50,
          role: 'admin', // Attempt to set system-managed field
          credits: 1000, // Attempt to set system-managed field
        },
        params: {},
      };

      const response = await controller.create(context);

      expect(response.success).toBe(true);
      expect(response.data!.role).toBe('user'); // Should use default
      expect(response.data!.credits).toBe(0); // Should use default
    });

    it('should block system-managed fields on update', async () => {
      const controller = new ProductController(ProductModel);

      const product = await ProductModel.create({
        name: 'Field Protection Test',
        description: 'Testing',
        price: 50,
        role: 'user',
        credits: 0,
      });

      const context: IRequestContext = {
        query: {},
        body: {
          name: 'Updated Name',
          role: 'admin', // Attempt to modify system-managed field
          credits: 9999, // Attempt to modify system-managed field
        },
        params: { id: product._id.toString() },
      };

      const response = await controller.update(context);

      expect(response.success).toBe(true);
      expect(response.data!.name).toBe('Updated Name');
      expect(response.data!.role).toBe('user'); // Should remain unchanged
      expect(response.data!.credits).toBe(0); // Should remain unchanged
    });
  });

  describe('Multi-Tenant Support', () => {
    it('should inject organizationId from context on create', async () => {
      const controller = new ProductController(ProductModel);

      const context: IRequestContext = {
        query: {},
        body: {
          name: 'Tenant Product',
          description: 'Multi-tenant test',
          price: 100,
        },
        params: {},
        context: {
          organizationId: 'org-123',
        },
      };

      const response = await controller.create(context);

      expect(response.success).toBe(true);
      expect(response.data!.organizationId).toBe('org-123');
    });

    it('should filter by organizationId in list', async () => {
      const controller = new ProductController(ProductModel);

      // Create products for different organizations
      await ProductModel.create([
        { name: 'Org1 Product', description: 'Desc', price: 10, organizationId: 'org-1' },
        { name: 'Org2 Product', description: 'Desc', price: 20, organizationId: 'org-2' },
        { name: 'Org1 Product 2', description: 'Desc', price: 30, organizationId: 'org-1' },
      ]);

      const context: IRequestContext = {
        query: {},
        body: {},
        params: {},
        context: {
          organizationId: 'org-1',
        },
      };

      const response = await controller.list(context);

      expect(response.success).toBe(true);
      const result = response.data as PaginationResult<IProduct>;
      expect(result.docs).toHaveLength(2);
      expect(result.docs.every((doc) => doc.organizationId === 'org-1')).toBe(true);
    });
  });

  describe('Lookup Sanitization', () => {
    it('should allow lookups from allowlist', async () => {
      const controller = new ProductController(ProductModel);

      const context: IRequestContext = {
        query: {
          lookup: {
            categories: {
              localField: 'categoryId',
              foreignField: '_id',
            },
          },
        },
        body: {},
        params: {},
      };

      const response = await controller.list(context);

      expect(response.success).toBe(true);
      // No error means lookup was allowed
    });

    it('should block lookups not in allowlist', async () => {
      const controller = new ProductController(ProductModel);

      const context: IRequestContext = {
        query: {
          lookup: {
            users: {
              // Not in allowlist
              localField: 'userId',
              foreignField: '_id',
            },
          },
        },
        body: {},
        params: {},
      };

      const response = await controller.list(context);

      expect(response.success).toBe(true);
      // Lookup should be filtered out (not cause error)
    });

    it('should enforce field-level allowlists', async () => {
      const controller = new ProductController(ProductModel);

      const context: IRequestContext = {
        query: {
          lookup: {
            categories: {
              localField: 'secretField', // Not in localFields allowlist
              foreignField: '_id',
            },
          },
        },
        body: {},
        params: {},
      };

      const response = await controller.list(context);

      expect(response.success).toBe(true);
      // Lookup should be filtered out due to field allowlist
    });
  });

  describe('Controller Extension', () => {
    it('should allow extending and overriding methods', async () => {
      const controller = new ExtendedProductController(ProductModel);

      // Test custom validation
      const context: IRequestContext = {
        query: {},
        body: {
          name: 'Invalid Product',
          description: 'Negative price test',
          price: -10, // Should be rejected
        },
        params: {},
      };

      const response = await controller.create(context);

      expect(response.success).toBe(false);
      expect(response.status).toBe(400);
      expect(response.error).toBe('Price cannot be negative');
    });

    it('should allow adding custom methods', async () => {
      const controller = new ExtendedProductController(ProductModel);

      // Create test data
      await ProductModel.create([
        { name: 'Featured 1', description: 'Desc', price: 10, featured: true },
        { name: 'Regular 1', description: 'Desc', price: 20, featured: false },
        { name: 'Featured 2', description: 'Desc', price: 30, featured: true },
      ]);

      const context: IRequestContext = {
        query: {},
        body: {},
        params: {},
      };

      const response = await controller.getFeatured(context);

      expect(response.success).toBe(true);
      const result = response.data as PaginationResult<IProduct>;
      expect(result.docs).toHaveLength(2);
      expect(result.docs.every((doc) => doc.featured === true)).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should return 400 when ID is missing', async () => {
      const controller = new ProductController(ProductModel);

      const context: IRequestContext = {
        query: {},
        body: {},
        params: {}, // Missing ID
      };

      const response = await controller.get(context);

      expect(response.success).toBe(false);
      expect(response.status).toBe(400);
      expect(response.error).toBe('Resource ID required');
    });

    it('should handle database errors gracefully', async () => {
      const controller = new ProductController(ProductModel);

      // Force an error by using invalid ObjectId
      const context: IRequestContext = {
        query: {},
        body: {},
        params: { id: 'invalid-id' },
      };

      const response = await controller.get(context);

      expect(response.success).toBe(false);
      expect(response.status).toBe(500);
      expect(response.error).toBeDefined();
    });
  });

  describe('Filtering and Sorting', () => {
    beforeEach(async () => {
      await ProductModel.create([
        { name: 'Product A', description: 'Desc', price: 30, status: 'published' },
        { name: 'Product B', description: 'Desc', price: 10, status: 'draft' },
        { name: 'Product C', description: 'Desc', price: 20, status: 'published' },
      ]);
    });

    it('should filter products by status', async () => {
      const controller = new ProductController(ProductModel);

      const context: IRequestContext = {
        query: {
          status: 'published', // QueryParser expects filters directly as query params
        },
        body: {},
        params: {},
      };

      const response = await controller.list(context);

      expect(response.success).toBe(true);
      const result = response.data as PaginationResult<IProduct>;
      expect(result.docs).toHaveLength(2);
      expect(result.docs.every((doc) => doc.status === 'published')).toBe(true);
    });

    it('should sort products by price', async () => {
      const controller = new ProductController(ProductModel);

      const context: IRequestContext = {
        query: {
          sort: { price: 1 }, // Ascending
        },
        body: {},
        params: {},
      };

      const response = await controller.list(context);

      expect(response.success).toBe(true);
      const result = response.data as PaginationResult<IProduct>;
      expect(result.docs[0].price).toBe(10);
      expect(result.docs[1].price).toBe(20);
      expect(result.docs[2].price).toBe(30);
    });
  });
});
