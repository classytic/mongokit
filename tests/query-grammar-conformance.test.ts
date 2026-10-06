import { matchesRecordFilter } from '@classytic/repo-core/filter';
import { toRecord } from '@classytic/repo-core/query-parser';
import {
  QUERY_GRAMMAR_DOCS,
  QUERY_GRAMMAR_FILTER_CASES,
  type QueryGrammarCaseOptions,
  runQueryGrammarConformance,
} from '@classytic/repo-core/testing';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueryParser } from '../src/query/QueryParser.js';
import { connectDB } from './setup.js';

function parserFor(options: QueryGrammarCaseOptions): QueryParser {
  return new QueryParser({
    maxLimit: options.maxLimit,
    ...(options.allowedFilterFields
      ? { allowedFilterFields: [...options.allowedFilterFields] }
      : {}),
    ...(options.allowedSortFields ? { allowedSortFields: [...options.allowedSortFields] } : {}),
  });
}

const parseFilters = (query: string, options: QueryGrammarCaseOptions) =>
  parserFor(options).parse(toRecord(new URLSearchParams(query)));

runQueryGrammarConformance('mongokit QueryParser', {
  parse(query, options) {
    const parsed = parseFilters(query, options);
    return {
      matches: (doc) => matchesRecordFilter(doc, parsed.filters as Record<string, unknown>),
      limit: parsed.limit,
      page: parsed.page,
      after: parsed.after,
      sort: parsed.sort as Record<string, 1 | -1> | undefined,
    };
  },
});

/** The same cases against a real MongoDB — the matcher models Mongo; this proves it. */
describe('query grammar conformance — mongokit QueryParser on MongoDB', () => {
  const collection = () => mongoose.connection.collection('query_grammar_conformance');

  beforeAll(async () => {
    await connectDB();
    await collection().deleteMany({});
    await collection().insertMany(QUERY_GRAMMAR_DOCS.map((doc) => ({ ...doc })) as never);
  });

  afterAll(async () => {
    await collection()
      .drop()
      .catch(() => undefined);
  });

  for (const { query, ids, options } of QUERY_GRAMMAR_FILTER_CASES) {
    it(`?${query}`, async () => {
      const parsed = parseFilters(query, { maxLimit: 100, defaultLimit: 20, ...options });
      const rows = await collection()
        .find(parsed.filters as Record<string, unknown>, { projection: { _id: 1 } })
        .sort({ _id: 1 })
        .toArray();
      expect(rows.map((row) => row._id)).toEqual([...ids]);
    });
  }
});
