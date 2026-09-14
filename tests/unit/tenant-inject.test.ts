/**
 * `@classytic/mongokit/tenant` — the ONE `injectTenantField`.
 *
 * Pure: a `Schema` is a registry-free object, so every assertion reads
 * `schema.indexes()` after the call and nothing touches a connection.
 *
 * Each test pins a behaviour that at least one of the 38 per-kernel copies got
 * wrong, so a future edit here cannot re-introduce a drift somewhere it was
 * already paid for.
 */
import { Schema } from 'mongoose';
import { resolveTenantConfig } from '@classytic/repo-core/tenant';
import { describe, expect, it } from 'vitest';
import {
  assertIndexDeclaration,
  declareIndexes,
  injectTenantField,
  type IndexDeclaration,
} from '../../src/tenant/index.js';

const scoped = () => resolveTenantConfig({ fieldType: 'objectId' });

function keysOf(schema: Schema): Array<{ keys: string[]; name?: string }> {
  return schema.indexes().map(([fields, options]) => ({
    keys: Object.keys(fields),
    ...(typeof options?.name === 'string' ? { name: options.name } : {}),
  }));
}

function byName(schema: Schema, name: string): Record<string, unknown> {
  const found = schema.indexes().find(([, o]) => o?.name === name);
  if (!found) throw new Error(`index ${name} not declared`);
  return found[0] as Record<string, unknown>;
}

describe('injectTenantField — the field', () => {
  it('adds an ObjectId field with the ref, required when scoped', () => {
    const schema = new Schema({ v: Number });
    injectTenantField(schema, scoped());
    const path = schema.path('organizationId');
    expect(path.instance).toBe('ObjectId');
    expect(path.options.ref).toBe('organization');
    expect(path.options.required).toBe(true);
  });

  it('adds a String field, not required, when scoping is disabled', () => {
    const schema = new Schema({ v: Number });
    injectTenantField(schema, resolveTenantConfig({ enabled: false, fieldType: 'string' }));
    const path = schema.path('organizationId');
    expect(path.instance).toBe('String');
    expect(path.options.required).toBeUndefined();
  });
});

describe('injectTenantField — the prepend pass', () => {
  it('leads every declared compound with the tenant field', () => {
    const schema = new Schema({ status: String, createdAt: Date });
    schema.index({ status: 1, createdAt: -1 });
    injectTenantField(schema, scoped());
    expect(keysOf(schema)).toEqual([{ keys: ['organizationId', 'status', 'createdAt'] }]);
  });

  it('leaves an index that already names the tenant field alone', () => {
    const schema = new Schema({ status: String });
    schema.index({ status: 1, organizationId: 1 }, { name: 'odd_but_explicit' });
    injectTenantField(schema, scoped());
    expect(Object.keys(byName(schema, 'odd_but_explicit'))).toEqual(['status', 'organizationId']);
  });

  it('never prefixes a TTL index (Mongo rejects a compound TTL spec)', () => {
    const schema = new Schema({ expiresAt: Date, status: String });
    schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl' });
    schema.index({ status: 1 }, { name: 'by_status' });
    injectTenantField(schema, scoped());
    expect(Object.keys(byName(schema, 'ttl'))).toEqual(['expiresAt']);
    expect(Object.keys(byName(schema, 'by_status'))).toEqual(['organizationId', 'status']);
  });

  it('keeps an index named in skipIndexes global', () => {
    const schema = new Schema({ eventId: String, status: String });
    schema.index({ eventId: 1 }, { unique: true, name: 'event_id_unique' });
    schema.index({ status: 1 }, { name: 'by_status' });
    injectTenantField(schema, scoped(), { skipIndexes: ['event_id_unique'] });
    expect(Object.keys(byName(schema, 'event_id_unique'))).toEqual(['eventId']);
    expect(Object.keys(byName(schema, 'by_status'))).toEqual(['organizationId', 'status']);
  });

  it('does not prepend when scoping is disabled', () => {
    const schema = new Schema({ status: String });
    schema.index({ status: 1 });
    injectTenantField(schema, resolveTenantConfig(false));
    expect(keysOf(schema)).toEqual([{ keys: ['status'] }]);
  });
});

describe('injectTenantField — the tenant-leading guarantee', () => {
  it('adds ONE bare tenant index only when nothing was prepended', () => {
    const schema = new Schema({ v: Number });
    injectTenantField(schema, scoped());
    expect(keysOf(schema)).toEqual([{ keys: ['organizationId'] }]);
  });

  it('adds no bare tenant index next to a prepended compound (redundant prefix)', () => {
    const schema = new Schema({ status: String });
    schema.index({ status: 1 });
    injectTenantField(schema, scoped());
    expect(keysOf(schema)).toHaveLength(1);
  });

  it('a global-only schema still gets a tenant-leading index for scoped lists', () => {
    const schema = new Schema({ eventId: String });
    schema.index({ eventId: 1 }, { name: 'event_id_unique' });
    injectTenantField(schema, scoped(), { skipIndexes: ['event_id_unique'] });
    expect(keysOf(schema)).toEqual([
      { keys: ['eventId'], name: 'event_id_unique' },
      { keys: ['organizationId'] },
    ]);
  });
});

describe('index declarations — scope', () => {
  const buyerHistory: IndexDeclaration = {
    fields: { customerId: 1, createdAt: -1 },
    scope: 'global',
    options: { name: 'buyer_history_global' },
  };

  it("a 'tenant' declaration (the default) is prefixed like the kernel's own", () => {
    const schema = new Schema({ status: String });
    injectTenantField(schema, scoped(), {
      indexes: [{ fields: { status: 1, createdAt: -1 }, options: { name: 'host_by_status' } }],
    });
    expect(Object.keys(byName(schema, 'host_by_status'))).toEqual([
      'organizationId',
      'status',
      'createdAt',
    ]);
  });

  it("a 'global' declaration is kept exactly as written, whatever the ordering", () => {
    const schema = new Schema({ customerId: String, status: String });
    schema.index({ status: 1 }, { name: 'by_status' });
    injectTenantField(schema, scoped(), { indexes: [buyerHistory] });
    expect(Object.keys(byName(schema, 'buyer_history_global'))).toEqual(['customerId', 'createdAt']);
    expect(Object.keys(byName(schema, 'by_status'))).toEqual(['organizationId', 'status']);
  });

  it('a tenant declaration that already leads with the field is not double-prefixed', () => {
    const schema = new Schema({ status: String });
    injectTenantField(schema, scoped(), {
      indexes: [{ fields: { organizationId: 1, status: 1 }, options: { name: 'explicit' } }],
    });
    expect(Object.keys(byName(schema, 'explicit'))).toEqual(['organizationId', 'status']);
  });

  it('passes the options (unique, partial filter, collation) through untouched', () => {
    const schema = new Schema({ publicId: String });
    injectTenantField(schema, scoped(), {
      indexes: [
        {
          fields: { publicId: 1 },
          options: {
            name: 'public_id',
            unique: true,
            partialFilterExpression: { publicId: { $type: 'string' } },
            collation: { locale: 'en', strength: 2 },
          },
        },
      ],
    });
    const [, options] = schema.indexes().find(([, o]) => o?.name === 'public_id')!;
    expect(options).toMatchObject({
      unique: true,
      partialFilterExpression: { publicId: { $type: 'string' } },
      collation: { locale: 'en', strength: 2 },
    });
  });

  it('with scoping disabled, scope is moot and every declaration is added as written', () => {
    const schema = new Schema({ customerId: String, status: String });
    injectTenantField(schema, resolveTenantConfig(false), {
      indexes: [buyerHistory, { fields: { status: 1 }, options: { name: 'by_status' } }],
    });
    expect(Object.keys(byName(schema, 'buyer_history_global'))).toEqual(['customerId', 'createdAt']);
    expect(Object.keys(byName(schema, 'by_status'))).toEqual(['status']);
  });

  it('declareIndexes alone serves a schema whose tenant field was injected elsewhere', () => {
    const schema = new Schema({ organizationId: Schema.Types.ObjectId, status: String });
    declareIndexes(schema, scoped(), [{ fields: { status: 1 }, options: { name: 'extra' } }]);
    expect(Object.keys(byName(schema, 'extra'))).toEqual(['organizationId', 'status']);
  });
});

describe('index declarations — refused at describe time', () => {
  const tenant = { tenantField: 'organizationId' };

  it('a global index must be named', () => {
    expect(() =>
      assertIndexDeclaration({ fields: { customerId: 1 }, scope: 'global' }, tenant),
    ).toThrow(/must be named/);
  });

  it('a global index must not name the tenant field', () => {
    expect(() =>
      assertIndexDeclaration(
        { fields: { organizationId: 1, customerId: 1 }, scope: 'global', options: { name: 'x' } },
        tenant,
      ),
    ).toThrow(/names the tenant field/);
  });

  it('a declaration needs a field', () => {
    expect(() => assertIndexDeclaration({ fields: {} }, tenant)).toThrow(/at least one field/);
  });

  it('a refused declaration leaves the schema untouched', () => {
    const schema = new Schema({ status: String });
    schema.index({ status: 1 });
    expect(() =>
      injectTenantField(schema, scoped(), {
        indexes: [{ fields: { customerId: 1 }, scope: 'global' }],
      }),
    ).toThrow();
    expect(schema.path('organizationId')).toBeUndefined();
    expect(keysOf(schema)).toEqual([{ keys: ['status'] }]);
  });
});
