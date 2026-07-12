import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { batchOperationsPlugin } from '../src/plugins/batch-operations.plugin.js';
import { methodRegistryPlugin } from '../src/plugins/method-registry.plugin.js';
import { mongoOperationsPlugin } from '../src/plugins/mongo-operations.plugin.js';
import { Repository } from '../src/Repository.js';
import { clearDB, connectDB, createTestModel, disconnectDB } from './setup.js';

interface IWidget {
  _id: mongoose.Types.ObjectId;
  name: string;
  qty: number;
}
const widgetSchema = new mongoose.Schema<IWidget>({
  name: { type: String, required: true },
  qty: { type: Number, default: 0 },
});

describe('Repository.getByIds — batch point-read', () => {
  let repo: Repository<IWidget>;
  let idA: string;
  let idB: string;
  let idC: string;

  const plugins = [methodRegistryPlugin(), mongoOperationsPlugin(), batchOperationsPlugin()];

  beforeAll(async () => {
    await connectDB();
    const Model = await createTestModel<IWidget>('GetByIdsWidget', widgetSchema);
    repo = new Repository(Model, plugins);
  });
  afterAll(async () => {
    await disconnectDB();
  });
  beforeEach(async () => {
    await clearDB();
    const a = (await repo.create({ name: 'A', qty: 1 } as Partial<IWidget>)) as IWidget;
    const b = (await repo.create({ name: 'B', qty: 2 } as Partial<IWidget>)) as IWidget;
    const c = (await repo.create({ name: 'C', qty: 3 } as Partial<IWidget>)) as IWidget;
    idA = String(a._id);
    idB = String(b._id);
    idC = String(c._id);
  });

  it('returns a Map keyed by _id for every found id', async () => {
    const map = await repo.getByIds([idA, idB, idC]);
    expect(map.size).toBe(3);
    expect((map.get(idA) as IWidget).name).toBe('A');
    expect((map.get(idC) as IWidget).name).toBe('C');
  });

  it('de-duplicates ids and omits ids with no matching doc', async () => {
    const missing = new mongoose.Types.ObjectId().toHexString();
    const map = await repo.getByIds([idA, idA, missing]);
    expect(map.size).toBe(1); // A once (deduped), missing absent
    expect(map.has(idA)).toBe(true);
    expect(map.has(missing)).toBe(false);
  });

  it('empty ids → empty map', async () => {
    expect((await repo.getByIds([])).size).toBe(0);
  });

  it('accepts ObjectId ids as well as strings', async () => {
    const map = await repo.getByIds([new mongoose.Types.ObjectId(idB)]);
    expect((map.get(idB) as IWidget).name).toBe('B');
  });

  it('drops structurally invalid ids instead of poisoning the batch', async () => {
    // Pre-fix this threw `Invalid _id` for the WHOLE batch — one malformed
    // id (stale reference, user input) lost every good result. Miss
    // semantics must mirror getById: invalid → absent, no throw.
    const map = await repo.getByIds([idA, 'not-a-valid-objectid', idC]);
    expect(map.size).toBe(2);
    expect(map.has(idA)).toBe(true);
    expect(map.has(idC)).toBe(true);
    expect(map.has('not-a-valid-objectid')).toBe(false);
  });

  it('all-invalid batch → empty map, no query', async () => {
    const map = await repo.getByIds(['nope', '', 'also-bad']);
    expect(map.size).toBe(0);
  });

  it('custom string idField — ids validated against the FIELD type, not _id', async () => {
    interface IEvent {
      _id: mongoose.Types.ObjectId;
      externalEventId: string;
      kind: string;
    }
    const eventSchema = new mongoose.Schema<IEvent>({
      externalEventId: { type: String, required: true, unique: true },
      kind: String,
    });
    const EventModel = await createTestModel<IEvent>('GetByIdsEvent', eventSchema);
    const eventRepo = new Repository<IEvent>(EventModel, plugins, undefined, {
      idField: 'externalEventId',
    });

    await eventRepo.create({ externalEventId: 'evt_abc', kind: 'gate' } as Partial<IEvent>);
    // 'evt_abc' is NOT a valid ObjectId — a blanket _id-type check would
    // wrongly drop it. Field-aware validation must let it through.
    const map = await eventRepo.getByIds(['evt_abc', 'evt_missing']);
    expect(map.size).toBe(1);
    expect((map.get('evt_abc') as IEvent).kind).toBe('gate');
  });
});
