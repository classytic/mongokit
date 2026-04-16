/**
 * Unit tests for the static regex-complexity budget.
 *
 * The budget is a defense-in-depth layer behind the heuristic
 * `dangerousRegexPatterns` detector. Patterns that slip past the heuristic
 * but cross the budget thresholds are still escaped (fail-safe).
 */

import { describe, expect, it, vi } from 'vitest';
import { QueryParser } from '../../src/query/QueryParser.js';
import * as logger from '../../src/utils/logger.js';

function parseRegex(parser: QueryParser, pattern: string): unknown {
  const out = parser.parse({ name: { regex: pattern } });
  return (out.filters.name as Record<string, unknown>)?.$regex;
}

describe('QueryParser — static regex complexity budget', () => {
  it('accepts a legitimate user-supplied pattern untouched', () => {
    const parser = new QueryParser();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const r = parseRegex(parser, '^user[0-9]+') as RegExp;
    expect(r).toBeInstanceOf(RegExp);
    // No budget warning for a simple pattern.
    const budgetWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('complexity budget'),
    );
    expect(budgetWarns.length).toBe(0);
    warnSpy.mockRestore();
  });

  it('escapes patterns with too many unbounded quantifiers (>20)', () => {
    const parser = new QueryParser();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // 25 unbounded quantifiers — well past the budget.
    const hostile = 'a*'.repeat(25);
    const r = parseRegex(parser, hostile) as RegExp;

    expect(r).toBeInstanceOf(RegExp);
    // Must have been escaped — original meta-chars are gone.
    expect(r.source).not.toBe(hostile);
    expect(r.source).toContain('\\*');
    warnSpy.mockRestore();
  });

  it('escapes patterns with too many nested groups (>8)', () => {
    const parser = new QueryParser();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const hostile = '('.repeat(10) + 'a' + ')'.repeat(10);
    const r = parseRegex(parser, hostile) as RegExp;
    // Escaped — the open-parens are literal.
    expect(r.source).toContain('\\(');
    warnSpy.mockRestore();
  });

  it('escapes patterns with too many alternations (>10)', () => {
    const parser = new QueryParser();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const hostile = Array.from({ length: 12 }, (_, i) => `opt${i}`).join('|');
    const r = parseRegex(parser, hostile) as RegExp;
    expect(r.source).toContain('\\|');
    warnSpy.mockRestore();
  });

  it('escapes combined group x quantifier density (>40)', () => {
    const parser = new QueryParser();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // 8 groups * 6 quantifiers = 48 — over the combined threshold.
    const hostile = '(a*)(b+)(c*)(d+)(e*)(f+)(g*)(h+)'.repeat(1) + 'i+';
    const r = parseRegex(parser, hostile) as RegExp;
    expect(r.source).toContain('\\(');
    warnSpy.mockRestore();
  });

  it('does not false-positive on escaped quantifiers (user wants literal *)', () => {
    const parser = new QueryParser();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Many literal escaped asterisks — should not trip the budget.
    const safe = '\\*'.repeat(25);
    const r = parseRegex(parser, safe) as RegExp;
    const budgetWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('complexity budget'),
    );
    expect(budgetWarns.length).toBe(0);
    expect(r).toBeInstanceOf(RegExp);
    warnSpy.mockRestore();
  });

  it('regexes that slip past the heuristic still get caught by the budget', () => {
    const parser = new QueryParser();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Pathological but syntactically simple — no nested (.+)+, no {n,m}.
    // Mostly unbounded quantifiers that aren't caught by the legacy detector.
    const slippery = 'x*y*z*w*v*u*t*s*r*q*p*o*n*m*l*k*j*i*h*g*f*e*d*c*b*a*';
    const r = parseRegex(parser, slippery) as RegExp;

    // Budget fires (25 unbounded quantifiers).
    const budgetWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('complexity budget'),
    );
    expect(budgetWarns.length).toBeGreaterThan(0);
    expect(r.source).toContain('\\*');
    warnSpy.mockRestore();
  });
});
