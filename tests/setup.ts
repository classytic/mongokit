/**
 * Test Setup
 * 
 * Shared utilities and setup for mongokit tests
 */

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/mongokit-test';

/**
 * Connect to MongoDB
 */
export async function connectDB(): Promise<void> {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(MONGODB_URI);
  }
}

/**
 * Disconnect from MongoDB
 */
export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
}

/**
 * Clear all collections
 */
export async function clearDB(): Promise<void> {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
}

/**
 * Create a test model with the given name and schema
 */
export function createTestModel<T>(name: string, schema: mongoose.Schema<T>) {
  // Delete model if it exists to allow re-registration
  if (mongoose.models[name]) {
    delete mongoose.models[name];
  }
  return mongoose.model<T>(name, schema);
}
