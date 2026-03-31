/**
 * Seed data for E2E pagination tests.
 *
 * Two lean collections (Product, Category) with predictable data
 * for verifying sort order, cursor stability, and join semantics.
 *
 * Usage:
 *   const { seedAll, ProductModel, CategoryModel } = await import('./fixtures/seed-products.js');
 *   await seedAll();
 */

import mongoose, { Schema, type Types } from 'mongoose';

// ── Interfaces ──

export interface ICategory {
  _id: Types.ObjectId;
  name: string;
  slug: string;
}

export interface IProduct {
  _id: Types.ObjectId;
  name: string;
  price: number;
  categorySlug: string;
  category?: Types.ObjectId;
  status: 'active' | 'draft' | 'archived';
}

// ── Schemas ──

const CategorySchema = new Schema<ICategory>({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
});

const ProductSchema = new Schema<IProduct>({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  categorySlug: { type: String, required: true },
  category: { type: Schema.Types.ObjectId, ref: 'SeedCat' },
  status: { type: String, enum: ['active', 'draft', 'archived'], default: 'active' },
});
ProductSchema.index({ price: -1, _id: -1 });
ProductSchema.index({ status: 1, price: -1, _id: -1 });

// ── Model registration (idempotent) ──

function getModel<T>(name: string, schema: Schema<T>): mongoose.Model<T> {
  if (mongoose.models[name]) delete mongoose.models[name];
  return mongoose.model<T>(name, schema);
}

export function getModels() {
  const CategoryModel = getModel<ICategory>('SeedCat', CategorySchema);
  const ProductModel = getModel<IProduct>('SeedProd', ProductSchema);
  return { CategoryModel, ProductModel };
}

// ── Seed data ──

const CATEGORIES = [
  { name: 'Electronics', slug: 'electronics' },
  { name: 'Clothing', slug: 'clothing' },
  { name: 'Books', slug: 'books' },
];

// 12 products — enough for multi-page tests with various page sizes
const PRODUCTS = [
  { name: 'Laptop',      price: 999,  categorySlug: 'electronics', status: 'active' as const },
  { name: 'Phone',       price: 699,  categorySlug: 'electronics', status: 'active' as const },
  { name: 'Tablet',      price: 499,  categorySlug: 'electronics', status: 'draft' as const },
  { name: 'Headphones',  price: 199,  categorySlug: 'electronics', status: 'active' as const },
  { name: 'T-Shirt',     price: 29,   categorySlug: 'clothing',    status: 'active' as const },
  { name: 'Jacket',      price: 149,  categorySlug: 'clothing',    status: 'active' as const },
  { name: 'Sneakers',    price: 120,  categorySlug: 'clothing',    status: 'active' as const },
  { name: 'Hat',         price: 25,   categorySlug: 'clothing',    status: 'archived' as const },
  { name: 'Novel',       price: 15,   categorySlug: 'books',       status: 'active' as const },
  { name: 'Textbook',    price: 89,   categorySlug: 'books',       status: 'active' as const },
  { name: 'Comic',       price: 12,   categorySlug: 'books',       status: 'draft' as const },
  { name: 'Magazine',    price: 8,    categorySlug: 'books',       status: 'archived' as const },
];

export async function seedAll() {
  const { CategoryModel, ProductModel } = getModels();
  await CategoryModel.init();
  await ProductModel.init();

  await CategoryModel.deleteMany({});
  await ProductModel.deleteMany({});

  const cats = await CategoryModel.create(CATEGORIES);
  const catMap = Object.fromEntries(cats.map((c) => [c.slug, c._id]));

  await ProductModel.create(
    PRODUCTS.map((p) => ({ ...p, category: catMap[p.categorySlug] })),
  );

  return { CategoryModel, ProductModel, catMap };
}

export const TOTAL_PRODUCTS = PRODUCTS.length;          // 12
export const ACTIVE_PRODUCTS = PRODUCTS.filter((p) => p.status === 'active').length; // 8
