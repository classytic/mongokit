import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
const srv = await MongoMemoryServer.create();
await mongoose.connect(srv.getUri(), { dbName: 'wf' });
const M = mongoose.model('W', new mongoose.Schema({ g: String, f: mongoose.Schema.Types.Mixed }, { strict: false }));
await M.insertMany([
  { g: 'a', f: 'x' }, { g: 'a', f: 'x' }, { g: 'a', f: 'y' }, { g: 'a', f: null }, { g: 'a' },
]);
const r = await M.aggregate([
  { $group: { _id: '$g', s: { $addToSet: { $cond: [{ $ne: ['$f', 'x'] }, '$f', '$$REMOVE'] } } } },
]);
console.log('  filtered set for group a:', JSON.stringify(r[0].s), '-> size', r[0].s.length);
