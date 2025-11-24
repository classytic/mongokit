/**
 * Next.js API Routes Example
 *
 * Shows how to use MongoKit in Next.js API routes
 */

import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';

// Define Model (put this in a shared location like lib/models/User.js)
const UserSchema = new mongoose.Schema({
  name: String,
  email: String,
  status: { type: String, default: 'active' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);

// Create Repository (reusable)
const userRepo = new Repository(User, [], {
  defaultLimit: 20,
  maxLimit: 100
});

// Helper to connect to DB
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose.connect(process.env.MONGODB_URI).then((mongoose) => mongoose);
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

/**
 * API Route: /api/users
 * GET - List users with pagination
 * POST - Create user
 */
export default async function handler(req, res) {
  await connectDB();

  if (req.method === 'GET') {
    try {
      const { page = 1, limit = 20, status } = req.query;

      const result = await userRepo.getAll({
        page: parseInt(page),
        limit: parseInt(limit),
        ...(status && { filters: { status } }),
        sort: { createdAt: -1 }
      });

      return res.status(200).json({
        users: result.docs,
        pagination: {
          page: result.page,
          total: result.total,
          pages: result.pages,
          hasNext: result.hasNext,
          hasPrev: result.hasPrev
        }
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const user = await userRepo.create(req.body);
      return res.status(201).json(user);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

/**
 * API Route: /api/users/[id]
 * GET - Get single user
 * PATCH - Update user
 * DELETE - Delete user
 */
export async function userByIdHandler(req, res) {
  await connectDB();

  const { id } = req.query;

  if (req.method === 'GET') {
    try {
      const user = await userRepo.getById(id);
      if (!user) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(user);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const user = await userRepo.update(id, req.body);
      if (!user) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(user);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await userRepo.delete(id);
      return res.status(204).end();
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

/**
 * Usage in Next.js:
 *
 * pages/api/users.js:
 *   export { default } from '@/examples/nextjs-api-route'
 *
 * pages/api/users/[id].js:
 *   export { userByIdHandler as default } from '@/examples/nextjs-api-route'
 *
 * Frontend:
 *   const res = await fetch('/api/users?page=1&limit=20')
 *   const data = await res.json()
 */
