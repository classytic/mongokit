/**
 * An over-large `limit` is CLAMPED, never rejected — and the generated schema must
 * not contradict that.
 *
 * `QueryParser.parse` has always clamped, with a comment saying capping is not
 * invalid. But `buildQuerySchema` emitted `maximum: maxLimit` into the querystring
 * JSON Schema, and Fastify validates BEFORE the parser runs — so the clamp was
 * unreachable and `?limit=200` returned a hard 400.
 *
 * The cost was not a visible error. Two commerce components passed `limit: 200` to a
 * `maxLimit: 100` resource, every request 400'd, and because neither read the query
 * error both rendered "no templates yet". A 400 disguised as an empty list.
 *
 * Both halves are pinned here, because either alone permits the contradiction to
 * return.
 */
import { describe, expect, it } from 'vitest';
import { QueryParser } from '../src/query/QueryParser.js';

const parser = new QueryParser({ maxLimit: 100, allowedFilterFields: ['name'] });

describe('limit cap', () => {
  it('CLAMPS an over-large limit instead of throwing', () => {
    const parsed = parser.parse({ limit: '200', page: '1' } as never);
    expect(parsed.limit).toBe(100);
  });

  it('leaves a limit under the cap alone', () => {
    expect(parser.parse({ limit: '25' } as never).limit).toBe(25);
  });

  it('does NOT emit `maximum` in the querystring schema', () => {
    /**
     * The regression guard. A `maximum` here is enforced by Fastify before the parser
     * is reached, which makes the clamp above dead code and turns a benign over-ask
     * into a total failure.
     */
    // `getQuerySchema()` is the method arc auto-detects to build the route's
    // querystring schema — so this is exactly what Fastify ends up validating against.
    const schema = parser.getQuerySchema();
    const limitSchema = (schema as { properties?: Record<string, Record<string, unknown>> })
      .properties?.limit;
    expect(limitSchema, 'no limit property in the generated schema').toBeDefined();
    expect(limitSchema?.maximum).toBeUndefined();
    // The cap is still COMMUNICATED, just not enforced twice.
    expect(String(limitSchema?.description)).toContain('100');
  });
});
