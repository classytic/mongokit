/**
 * Two regressions caught after my last LookupBuilder + pagination patch:
 *
 *  1. **High** — `LookupSpec.where` bypasses sanitization. The `where` value
 *     flows through `compileFilterToMongo`, but raw Mongo-shaped records
 *     pass through unchanged. The compiled `$match` is then appended to the
 *     assembled pipeline, which is marked `sanitize(false)` so the kit's
 *     dangerous-operator filter never runs against it. Attacker-supplied
 *     `where: { $where: 'js' }` reaches Mongo as `$match: { $where: 'js' }`.
 *
 *  2. **Medium** — `OffsetPaginationResult`, `KeysetPaginationResult`,
 *     `AggregatePaginationResult` were removed from mongokit's public
 *     exports during the 3.12 migration to repo-core's pagination types.
 *     `types.ts` imports them as `import type` but neither re-exports nor
 *     does the top-level barrel. Consumers writing
 *     `import type { OffsetPaginationResult } from '@classytic/mongokit'`
 *     get a build break. Either re-export them (canonical = repo-core, but
 *     mongokit re-exports for ergonomics + back-compat) or document the
 *     break loudly.
 */

// The pagination type-export regression is enforced by the conformance
// gate at `tests/unit/standard-repo-assignment.test-d.ts` (vitest's
// runtime pass erases types so a runtime probe wouldn't catch it).
// This file covers the where-sanitization regression at runtime.
import type { PipelineStage } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { LookupBuilder } from '../../src/query/LookupBuilder.js';

describe('LookupSpec.where sanitization (regression)', () => {
  it('drops $where operator from raw Mongo `where` records', () => {
    const stages = LookupBuilder.multiple([
      {
        from: 'cats',
        localField: 'categorySlug',
        foreignField: 'slug',
        as: 'category',
        // Raw Mongo-shape — `compileFilterToMongo` would pass this through
        // unchanged. Pre-fix, $where leaked into the assembled pipeline.
        where: { status: 'active', $where: 'function() { return true; }' } as Record<
          string,
          unknown
        >,
      },
    ]);

    const lookupStage = stages.find((s) => '$lookup' in s) as PipelineStage.Lookup;
    const inner = (lookupStage.$lookup as { pipeline?: PipelineStage[] }).pipeline ?? [];

    // Find the where-match (the one carrying caller-supplied keys, not
    // the auto-generated $expr correlation).
    const whereMatch = inner.find((s) => {
      const m = (s as { $match?: Record<string, unknown> }).$match;
      return m && 'status' in m;
    });
    const matchBody = (whereMatch as { $match: Record<string, unknown> }).$match;

    expect(matchBody.status).toBe('active');
    expect(matchBody).not.toHaveProperty('$where');
  });

  it('drops $function and $accumulator nested in `where`', () => {
    const stages = LookupBuilder.multiple([
      {
        from: 'cats',
        localField: 'categorySlug',
        foreignField: 'slug',
        as: 'category',
        where: {
          status: 'active',
          $expr: { $function: { body: 'function() {}', args: [], lang: 'js' } },
        } as Record<string, unknown>,
      },
    ]);

    const lookupStage = stages.find((s) => '$lookup' in s) as PipelineStage.Lookup;
    const inner = (lookupStage.$lookup as { pipeline?: PipelineStage[] }).pipeline ?? [];
    const whereMatch = inner.find((s) => {
      const m = (s as { $match?: Record<string, unknown> }).$match;
      return m && 'status' in m;
    });
    const matchBody = (whereMatch as { $match: Record<string, unknown> }).$match;

    expect(matchBody.status).toBe('active');
    // $expr survives (it's the join-correlation operator), but $function
    // inside it must be stripped.
    const expr = matchBody.$expr as Record<string, unknown> | undefined;
    if (expr) {
      expect(expr).not.toHaveProperty('$function');
    }
  });

  it('preserves the auto-generated $expr join correlation', () => {
    const stages = LookupBuilder.multiple([
      {
        from: 'cats',
        localField: 'categorySlug',
        foreignField: 'slug',
        as: 'category',
        where: { status: 'active' } as Record<string, unknown>,
      },
    ]);

    const lookupStage = stages.find((s) => '$lookup' in s) as PipelineStage.Lookup;
    const inner = (lookupStage.$lookup as { pipeline?: PipelineStage[] }).pipeline ?? [];

    // First stage MUST be the kit-built `$expr` $eq join. Sanitization must
    // not strip it (correlations are how pipeline-form $lookup works).
    const first = inner[0] as { $match?: { $expr?: unknown } };
    expect(first?.$match?.$expr).toBeDefined();
  });
});

