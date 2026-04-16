/**
 * Unit tests for QueryParser depth-bomb hardening.
 *
 * Two recursive surfaces are guarded:
 *   1. `_parseFilters` / `_handleBracketSyntax` — for URL filter input.
 *   2. `_sanitizeMatchConfig` — for aggregation `$match` input.
 *
 * Both must survive adversarial deep nesting without stack overflow or
 * latency spikes, and both must emit a structured warning when truncated.
 */

import { describe, expect, it, vi } from 'vitest';
import { QueryParser } from '../../src/query/QueryParser.js';
import * as logger from '../../src/utils/logger.js';

function buildDeepMatch(depth: number, leaf: unknown = { status: 'active' }): Record<string, unknown> {
  let node: Record<string, unknown> = { ...(leaf as Record<string, unknown>) };
  for (let i = 0; i < depth; i++) {
    node = { ['lvl' + i]: node };
  }
  return node;
}

describe('QueryParser — filter parse depth', () => {
  it('parses deep URL bracket input without crashing', () => {
    const parser = new QueryParser({ maxFilterDepth: 3 });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // URL-style object: a[b][c][d][e]=1 decodes roughly to this shape.
    const hostile = {
      field: { gt: 1, foo: { bar: { baz: { deep: 1 } } } },
    };
    expect(() => parser.parse(hostile)).not.toThrow();
    warnSpy.mockRestore();
  });

  it('survives a 10_000-level-deep object without stack overflow', () => {
    const parser = new QueryParser({ maxFilterDepth: 10 });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Build { a: { a: { a: ... } } } 10k deep — worst case for recursive parsers.
    let hostile: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 10_000; i++) hostile = { a: hostile };

    const start = Date.now();
    expect(() => parser.parse(hostile)).not.toThrow();
    expect(Date.now() - start).toBeLessThan(1_000);
    warnSpy.mockRestore();
  });
});

describe('QueryParser — $match sanitize depth ($sanitizeMatchConfig)', () => {
  it('truncates beyond maxFilterDepth and warns', () => {
    const parser = new QueryParser({ maxFilterDepth: 4, enableAggregations: true });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const hostile = buildDeepMatch(50);
    const { aggregation } = parser.parse({
      aggregate: { match: hostile },
    } as Record<string, unknown>);
    const stages = aggregation ?? [];

    expect(Array.isArray(stages)).toBe(true);
    const depthWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('sanitize depth'),
    );
    expect(depthWarns.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });

  it('survives a 10_000-level-deep $match without stack overflow', () => {
    const parser = new QueryParser({ maxFilterDepth: 10, enableAggregations: true });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const hostile = buildDeepMatch(10_000);

    const start = Date.now();
    expect(() =>
      parser.parse({ aggregate: { match: hostile } } as Record<string, unknown>),
    ).not.toThrow();
    expect(Date.now() - start).toBeLessThan(1_500);
    warnSpy.mockRestore();
  });

  it('accepts a match config within the depth budget', () => {
    const parser = new QueryParser({ maxFilterDepth: 10, enableAggregations: true });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const ok = buildDeepMatch(4);
    const { aggregation } = parser.parse({
      aggregate: { match: ok },
    } as Record<string, unknown>);
    const stages = aggregation ?? [];

    expect(Array.isArray(stages)).toBe(true);
    const depthWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('sanitize depth'),
    );
    expect(depthWarns.length).toBe(0);
    warnSpy.mockRestore();
  });

  it('hostile $or chain with thousands of branches is handled safely', () => {
    const parser = new QueryParser({ maxFilterDepth: 6, enableAggregations: true });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Nested $or — each branch contains deeper nesting.
    let hostile: Record<string, unknown> = { status: 'active' };
    for (let i = 0; i < 200; i++) hostile = { $or: [hostile, { [`f${i}`]: i }] };

    const start = Date.now();
    expect(() =>
      parser.parse({ aggregate: { match: hostile } } as Record<string, unknown>),
    ).not.toThrow();
    expect(Date.now() - start).toBeLessThan(500);
    warnSpy.mockRestore();
  });
});
