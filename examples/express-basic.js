/**
 * Express Basic Example
 *
 * Simple REST API with offset pagination
 */

import express from 'express';
import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';

// Define Model
const UserSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  status: { type: String, default: 'active' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);

// Create Repository
const userRepo = new Repository(User, [], {
  defaultLimit: 20,
  maxLimit: 100
});

// Express App
const app = express();
app.use(express.json());

// GET /users - Paginated list
app.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;

    const result = await userRepo.getAll({
      page: parseInt(page),
      limit: parseInt(limit),
      ...(status && { filters: { status } }),
      sort: { createdAt: -1 }
    });

    res.json({
      users: result.docs,
      pagination: {
        page: result.page,
        total: result.total,
        pages: result.pages,
        hasNext: result.hasNext
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /users/:id - Single user
app.get('/users/:id', async (req, res) => {
  try {
    const user = await userRepo.getById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /users - Create user
app.post('/users', async (req, res) => {
  try {
    const user = await userRepo.create(req.body);
    res.status(201).json(user);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PATCH /users/:id - Update user
app.patch('/users/:id', async (req, res) => {
  try {
    const user = await userRepo.update(req.params.id, req.body);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /users/:id - Delete user
app.delete('/users/:id', async (req, res) => {
  try {
    await userRepo.delete(req.params.id);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start
mongoose.connect('mongodb://localhost:27017/myapp')
  .then(() => {
    app.listen(3000, () => {
      console.log('Server: http://localhost:3000');
      console.log('Try: http://localhost:3000/users?page=1&limit=10');
    });
  });
