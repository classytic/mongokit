/**
 * Unit tests for vector search error classification.
 *
 * Pure — no mongo. Exercises `classifyVectorSearchError` against the error
 * shapes we've seen in the wild + `withVectorErrorHints` translation.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyVectorSearchError,
  withVectorErrorHints,
} from '../../src/ai/vector-error-hints.js';

const CTX = {
  indexName: 'mongokit_idx',
  dimensions: 1536,
  filterPaths: ['tenantId'],
};

describe('classifyVectorSearchError — pattern matching', () => {
  it('detects standalone/memory-server ($vectorSearch unsupported)', () => {
    const err = new Error("Unrecognized pipeline stage name: '$vectorSearch'");
    const hint = classifyVectorSearchError(err, CTX);
    expect(hint.code).toBe('NOT_ATLAS');
    expect(hint.summary).toMatch(/Atlas-only/);
    expect(hint.hints.some((h) => h.includes('Atlas'))).toBe(true);
  });

  it('detects the double-quoted variant', () => {
    const err = new Error('Unrecognized pipeline stage name: "$vectorSearch"');
    expect(classifyVectorSearchError(err, CTX).code).toBe('NOT_ATLAS');
  });

  it('detects Atlas missing-index errors', () => {
    const err = new Error(
      "PlanExecutor error during aggregation :: caused by :: $vectorSearch couldn't find index 'mongokit_idx'",
    );
    const hint = classifyVectorSearchError(err, CTX);
    expect(hint.code).toBe('INDEX_NOT_FOUND');
    expect(hint.summary).toContain('mongokit_idx');
    expect(hint.hints.some((h) => h.includes('queryable: true'))).toBe(true);
    expect(hint.hints.some((h) => h.includes('1536'))).toBe(true);
  });

  it('detects undeclared filter field', () => {
    const err = new Error(
      "Path 'tenantId' is not a filter field in the vector search index.",
    );
    const hint = classifyVectorSearchError(err, CTX);
    expect(hint.code).toBe('FILTER_FIELD_NOT_INDEXED');
    expect(hint.hints.some((h) => h.includes('tenantId'))).toBe(true);
    expect(hint.hints.some((h) => h.includes('type: "filter"'))).toBe(true);
  });

  it('detects dimension mismatch', () => {
    const err = new Error(
      'Query vector dimension 768 does not match expected 1536.',
    );
    expect(classifyVectorSearchError(err, CTX).code).toBe('DIMENSION_MISMATCH');
  });

  it('returns UNKNOWN for unrelated errors', () => {
    const err = new Error('connection refused 127.0.0.1:27017');
    expect(classifyVectorSearchError(err, CTX).code).toBe('UNKNOWN');
  });

  it('handles string errors', () => {
    expect(
      classifyVectorSearchError("Unrecognized pipeline stage name: '$vectorSearch'", CTX)
        .code,
    ).toBe('NOT_ATLAS');
  });

  it('handles plain object errors with errmsg', () => {
    const err = { code: 40324, errmsg: "Unrecognized pipeline stage name: '$vectorSearch'" };
    expect(classifyVectorSearchError(err, CTX).code).toBe('NOT_ATLAS');
  });
});

describe('withVectorErrorHints — translation', () => {
  it('rewraps known errors with hint text + preserves .cause', async () => {
    const original = new Error("Unrecognized pipeline stage name: '$vectorSearch'");

    await expect(
      withVectorErrorHints(async () => {
        throw original;
      }, CTX),
    ).rejects.toSatisfy((err: Error) => {
      expect(err.message).toMatch(/\[mongokit:vector\]/);
      expect(err.message).toMatch(/Atlas-only/);
      expect((err as Error & { code?: string }).code).toBe('NOT_ATLAS');
      expect((err as Error & { cause?: unknown }).cause).toBe(original);
      return true;
    });
  });

  it('passes through unrecognized errors untouched', async () => {
    const original = new Error('connection refused');
    await expect(
      withVectorErrorHints(async () => {
        throw original;
      }, CTX),
    ).rejects.toBe(original);
  });

  it('returns the op result unchanged on success', async () => {
    const out = await withVectorErrorHints(async () => 42, CTX);
    expect(out).toBe(42);
  });
});
