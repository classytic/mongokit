/**
 * Test Setup
 * 
 * Shared utilities and setup for mongokit tests
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let memoryServer: MongoMemoryServer | null = null;
let effectiveMongoUri: string | null = null;

/**
 * Connect to MongoDB
 */
export async function connectDB(): Promise<void> {
  if (mongoose.connection.readyState === 0) {
    if (!effectiveMongoUri) {
      if (process.env.MONGODB_URI) {
        effectiveMongoUri = process.env.MONGODB_URI;
      } else {
        memoryServer = await MongoMemoryServer.create();
        effectiveMongoUri = memoryServer.getUri('mongokit-test');
      }
    }

    await mongoose.connect(effectiveMongoUri);
  }
}

/**
 * Disconnect from MongoDB
 */
export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();

  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }

  effectiveMongoUri = null;
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
export async function createTestModel<T>(name: string, schema: mongoose.Schema<T>): Promise<mongoose.Model<T>> {
  // Delete model if it exists to allow re-registration
  if (mongoose.models[name]) {
    delete mongoose.models[name];
  }
  const model = mongoose.model<T>(name, schema);
  await model.init();
  return model;
}
