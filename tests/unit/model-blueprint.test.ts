/**
 * `defineModels()` — the describe/bind blueprint (STANDARDIZATION-PLAN §5, §9 Phase 1).
 *
 * These are the FALSIFICATION tests: each one fails against an eager or permissive
 * implementation. They run in the `unit` project — no MongoMemoryServer — because
 * `mongoose.createConnection()` (unconnected) yields a real per-connection model registry,
 * and `connection.model()` is registry-only with no network I/O. That is precisely the
 * property the standard relies on: describing + binding models touches no database.
 */
import mongoose, { Schema } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineModels, type ModelSpec } from '../../src/model-blueprint.js';
import { ModelCollisionError } from '../../src/model-registry.js';

const NODE_ENV = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = NODE_ENV;
});

/** A fresh, UNCONNECTED connection — a real registry, zero network. */
function freshConnection() {
  return mongoose.createConnection();
}

function spec(name: string, over: Partial<ModelSpec> = {}): ModelSpec {
  return {
    name,
    schema: () => new Schema({ v: Number }),
    existing: { mode: 'throw' },
    ...over,
  };
}

describe('defineModels — describe phase (no connection)', () => {
  it('rejects duplicate spec names at DESCRIBE time, before any connection', () => {
    expect(() =>
      defineModels({
        models: [spec('Dup'), spec('Dup')],
        assemble: (m) => m,
      }),
    ).toThrow(/duplicate model spec name 'Dup'/);
  });

  it('exposes modelNames without a connection and never builds a schema', () => {
    const build = vi.fn(() => new Schema({ v: Number }));
    const bp = defineModels({
      models: [spec('A', { schema: build }), spec('B', { schema: build })],
      assemble: (m) => m,
    });
    expect(bp.modelNames).toEqual(['A', 'B']);
    // Describe is pure: the schema factory has NOT run.
    expect(build).not.toHaveBeenCalled();
  });

  it('registers nothing on the global mongoose registry at describe time', () => {
    const before = Object.keys(mongoose.models).length;
    defineModels({ models: [spec('DescribeOnly')], assemble: (m) => m });
    expect(Object.keys(mongoose.models)).toHaveLength(before);
    expect(mongoose.models.DescribeOnly).toBeUndefined();
  });
});

describe('defineModels — bind phase', () => {
  it('binds each model connection-locally and assembles the typed bag', () => {
    const conn = freshConnection();
    const bp = defineModels({
      models: [spec('Order'), spec('Line', { collection: 'order_lines' })],
      assemble: (m) => ({ Order: m.get('Order')!, Line: m.get('Line')! }),
    });
    const models = bp.bind(conn);
    expect(models.Order.modelName).toBe('Order');
    expect(models.Line.collection.name).toBe('order_lines');
    // Connection-local, not global.
    expect(conn.models.Order).toBeDefined();
    expect(mongoose.models.Order).toBeUndefined();
  });

  it('builds each schema factory exactly once, on bind', () => {
    const build = vi.fn(() => new Schema({ v: Number }));
    const conn = freshConnection();
    defineModels({ models: [spec('BuildOnce', { schema: build })], assemble: (m) => m }).bind(conn);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('gives two connections DISTINCT model instances from one blueprint', () => {
    const bp = defineModels({ models: [spec('Shared')], assemble: (m) => m.get('Shared')! });
    const a = bp.bind(freshConnection());
    const b = bp.bind(freshConnection());
    expect(a).not.toBe(b);
    expect(a.modelName).toBe('Shared');
    expect(b.modelName).toBe('Shared');
  });

  it('bind performs NO index I/O — spies installed BEFORE bind, on the Model base', () => {
    // Spy on the base Model statics so a subclass compiled DURING bind inherits the spy.
    // (The previous version spied the model AFTER bind and could not observe binding at all.)
    const createIndexes = vi.spyOn(mongoose.Model, 'createIndexes');
    const syncIndexes = vi.spyOn(mongoose.Model, 'syncIndexes');
    try {
      const conn = freshConnection();
      defineModels({ models: [spec('NoIdx')], assemble: (m) => m.get('NoIdx')! }).bind(conn);
      expect(createIndexes).not.toHaveBeenCalled();
      expect(syncIndexes).not.toHaveBeenCalled();
    } finally {
      createIndexes.mockRestore();
      syncIndexes.mockRestore();
    }
  });
});

describe('defineModels — existing-model policies', () => {
  it("'reuse' returns the existing model WITHOUT running the incoming schema factory", () => {
    const conn = freshConnection();
    conn.model('Reused', new Schema({ original: Boolean }));
    const build = vi.fn(() => new Schema({ v: Number }));
    const model = defineModels({
      models: [spec('Reused', { schema: build, existing: { mode: 'reuse' } })],
      assemble: (m) => m.get('Reused')!,
    }).bind(conn);
    expect(build).not.toHaveBeenCalled();
    expect(model.modelName).toBe('Reused');
  });

  it("'throw' fails loud on an existing model, with model + set diagnostics", () => {
    const conn = freshConnection();
    conn.model('Clash', new Schema({ original: Boolean }));
    expect(() =>
      defineModels({
        models: [spec('Clash', { existing: { mode: 'throw', hint: 'seed twice?' } })],
        assemble: (m) => m,
      }).bind(conn),
    ).toThrow(/model 'Clash' is already registered/);
  });

  it("'replace' clobbers an existing model in non-production", () => {
    process.env.NODE_ENV = 'test';
    const conn = freshConnection();
    conn.model('Repl', new Schema({ original: Boolean }));
    const model = defineModels({
      models: [spec('Repl', { schema: () => new Schema({ fresh: Boolean }), existing: { mode: 'replace', environment: 'test' } })],
      assemble: (m) => m.get('Repl')!,
    }).bind(conn);
    expect(model.schema.path('fresh')).toBeDefined();
    expect(model.schema.path('original')).toBeUndefined();
  });

  it("'replace' is REJECTED when NODE_ENV=production", () => {
    process.env.NODE_ENV = 'production';
    const conn = freshConnection();
    conn.model('ProdRepl', new Schema({ original: Boolean }));
    expect(() =>
      defineModels({
        models: [spec('ProdRepl', { existing: { mode: 'replace', environment: 'test' } })],
        assemble: (m) => m,
      }).bind(conn),
    ).toThrow(/forbidden when NODE_ENV=production/);
  });
});

describe('defineModels — partial-bind rollback', () => {
  it('RESTORES a replaced model when a later spec fails (finding #2)', () => {
    process.env.NODE_ENV = 'test';
    const conn = freshConnection();
    // Original model A exists (distinct schema we can identify after restore).
    conn.model('A', new Schema({ originalMarker: Boolean }, { collection: 'orig_a' }));
    const originalA = conn.models.A;

    const bp = defineModels({
      models: [
        // Replace A with a different schema...
        spec('A', { schema: () => new Schema({ replacementMarker: Boolean }), existing: { mode: 'replace', environment: 'test' } }),
        // ...then B collides (pre-existing + throw) → bind fails AFTER A was replaced.
        spec('B'),
      ],
      assemble: (m) => m,
    });
    conn.model('B', new Schema({ x: Number })); // make B collide

    expect(() => bp.bind(conn)).toThrow();
    // A must still exist with its ORIGINAL schema (not the replacement, not missing).
    // deleteModel destroyed the original Model OBJECT, so restore re-registers from the
    // captured schema — identity is proven by the schema markers + collection, not `toBe`.
    expect(conn.models.A).toBeDefined();
    expect(conn.models.A.schema.path('originalMarker')).toBeDefined();
    expect(conn.models.A.schema.path('replacementMarker')).toBeUndefined();
    expect(conn.models.A.collection.name).toBe('orig_a');
    void originalA;
  });

  it('rethrows the ORIGINAL typed error (ModelCollisionError), not a wrapper', () => {
    const conn = freshConnection();
    conn.model('Taken', new Schema({ x: Number }));
    expect(() =>
      defineModels({ models: [spec('Taken', { existing: { mode: 'throw' } })], assemble: (m) => m }).bind(conn),
    ).toThrow(ModelCollisionError);
  });

  it('removes ONLY the models this bind created, never a pre-existing one, on failure', () => {
    const conn = freshConnection();
    // A model that already exists — a later 'throw' spec on it triggers the failure.
    conn.model('PreExisting', new Schema({ original: Boolean }));

    const bp = defineModels({
      models: [
        spec('FreshA'), // this bind creates it
        spec('PreExisting', { existing: { mode: 'throw' } }), // collides → bind fails here
        spec('FreshB'), // never reached
      ],
      assemble: (m) => m,
    });

    // Rethrows the ORIGINAL typed error (not a wrapper), and rolls back what it created.
    expect(() => bp.bind(conn)).toThrow(ModelCollisionError);
    // Rolled back: the model THIS bind created is gone from the registry...
    expect(conn.models.FreshA).toBeUndefined();
    // ...but the pre-existing model it did NOT create is untouched.
    expect(conn.models.PreExisting).toBeDefined();
    expect(conn.models.FreshB).toBeUndefined();
  });
});
