/**
 * Pagination hardening (Stage 1b): a total order on every page, hasNext from limit+1, a
 * deep-offset guard, cursors refused when tampered or replayed against another scope, keyset
 * over null/missing and Decimal128 keys, one count shape across strategies (incl. `cached`),
 * scope on the count, and a bounded-memory (two-phase, no `$facet`) aggregate page.
 */

import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  configurePaginationDefaults,
  multiTenantPlugin,
  PAGINATION_ERROR_CODES,
  Repository,
  resetPaginationDefaults,
  softDeletePlugin,
} from '../../src/index.js';
import { type RecordedCommand, recordCommands } from '../../src/testkit/index.js';
import { connectDB, getMongoUri } from '../setup.js';

interface IRow {
  organizationId: string;
  status: string;
  rank?: number | null;
  price?: mongoose.Types.Decimal128;
  name: string;
  deletedAt?: Date | null;
}

type Page = { method: string; data: IRow[]; next?: string | null; hasMore?: boolean; hasNext?: boolean };

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describe('pagination hardening', () => {
  let conn: Connection;
  let Row: Model<IRow>;
  let Other: Model<IRow>;
  let repo: Repository<IRow>;
  let scoped: Repository<IRow>;
  const coll = () => Row.collection.collectionName;
  const on = (cmds: RecordedCommand[], name: string) =>
    cmds.filter((c) => c.name === name && c.collection === coll());

  beforeAll(async () => {
    await connectDB();
    conn = await mongoose.createConnection(getMongoUri(), { monitorCommands: true }).asPromise();
    const schema = () =>
      new Schema<IRow>({
        organizationId: String,
        status: String,
        rank: { type: Number, default: undefined },
        price: Schema.Types.Decimal128,
        name: String,
        deletedAt: { type: Date, default: null },
      });
    Row = conn.model<IRow>('PagHardRow', schema());
    Other = conn.model<IRow>('PagHardOther', schema());
    await Promise.all([Row.deleteMany({}), Other.deleteMany({})]);
    const ranks: Array<number | null | undefined> = [null, undefined, 1, 2, 2, 3, null, 2, undefined, 5];
    await Row.insertMany(
      Array.from({ length: 30 }, (_, i) => ({
        organizationId: i % 3 === 0 ? 'org-b' : 'org-a',
        status: ['open', 'paid'][i % 2] as string,
        ...(ranks[i % ranks.length] === undefined ? {} : { rank: ranks[i % ranks.length] }),
        price: mongoose.Types.Decimal128.fromString(`${(i % 7) + 0.5}`),
        name: `row-${String(i).padStart(2, '0')}`,
      })),
    );
    await Other.insertMany([{ organizationId: 'org-a', status: 'open', name: 'other', rank: 1 }]);
    repo = new Repository<IRow>(Row);
    scoped = new Repository<IRow>(Row, [multiTenantPlugin({ tenantField: 'organizationId' }), softDeletePlugin()]);
  });
  afterAll(async () => {
    await Promise.all([Row.deleteMany({}), Other.deleteMany({})]);
    await conn.close();
  });
  afterEach(() => resetPaginationDefaults());

  describe('total order and hasNext', () => {
    it('an offset page sorts with a unique _id tiebreaker appended to the caller sort', async () => {
      const { commands } = await recordCommands(conn, () => repo.getAll({ sort: { status: 1 }, page: 1, limit: 5 }));
      const sort = on(commands, 'find')[0]?.command.sort;
      // The driver hands the sort over as an ordered Map.
      expect(sort instanceof Map ? Object.fromEntries(sort) : sort).toEqual({ status: 1, _id: 1 });
    });

    it('offset paging over a tie-heavy sort returns every row exactly once', async () => {
      const seen: string[] = [];
      for (let page = 1; page <= 6; page++) {
        const r = (await repo.getAll({ sort: { status: -1 }, page, limit: 5 })) as Page;
        seen.push(...r.data.map((d) => d.name));
      }
      expect(seen).toHaveLength(30);
      expect(new Set(seen).size).toBe(30);
    });

    it('hasNext comes from a limit+1 fetch even with an exact count', async () => {
      const { result, commands } = await recordCommands(conn, () =>
        repo.getAll({ sort: { name: 1 }, page: 6, limit: 5, countStrategy: 'exact' }),
      );
      expect(on(commands, 'find')[0]?.command.limit).toBe(6);
      expect((result as Page).hasNext).toBe(false);
      expect((result as Page).data).toHaveLength(5);
    });

    it('the portable aggregatePaginate offset sort carries the group keys as tiebreaker', async () => {
      const { commands } = await recordCommands(conn, () =>
        repo.aggregatePaginate({ groupBy: 'status', measures: { n: { op: 'count' } }, sort: { n: -1 }, limit: 5 }),
      );
      const stages = (on(commands, 'aggregate')[0]?.command.pipeline ?? []) as Array<Record<string, unknown>>;
      expect(stages.find((s) => s.$sort)?.$sort).toEqual({ n: -1, status: 1 });
    });
  });

  describe('deep-offset guard', () => {
    it('a skip above the deployment cap is refused with a typed "use keyset" error', async () => {
      configurePaginationDefaults({ maxOffset: 20 });
      await expect(repo.getAll({ sort: { name: 1 }, page: 5, limit: 5 })).resolves.toBeDefined();
      let caught: { status?: number; code?: string; message?: string } = {};
      try {
        await repo.getAll({ sort: { name: 1 }, page: 6, limit: 5 });
      } catch (err) {
        caught = err as typeof caught;
      }
      expect(caught.status).toBe(400);
      expect(caught.code).toBe(PAGINATION_ERROR_CODES.OFFSET_TOO_DEEP);
      expect(caught.message).toMatch(/keyset/);
      expect(await codeOf(repo.lookupPopulate({ filters: {}, lookups: [], page: 6, limit: 5 }))).toBe(
        PAGINATION_ERROR_CODES.OFFSET_TOO_DEEP,
      );
      expect(
        await codeOf(repo.aggregatePaginate({ groupBy: 'name', measures: { n: { op: 'count' } }, page: 6, limit: 5 })),
      ).toBe(PAGINATION_ERROR_CODES.OFFSET_TOO_DEEP);
    });
  });

  describe('cursor integrity', () => {
    async function firstCursor(r: Repository<IRow>, opts: Record<string, unknown> = {}): Promise<string> {
      const page = (await r.getAll({ sort: { name: 1 }, limit: 3, mode: 'keyset', ...opts })) as Page;
      expect(page.next).toBeTruthy();
      return page.next as string;
    }

    it('a tampered (signed deployment) or truncated cursor is a 400 with a closed code', async () => {
      // Only an HMAC can reveal a flipped byte that still decodes, so the deployment signs.
      configurePaginationDefaults({ cursorSecret: 'pagination-hardening-secret-0123456789' });
      const token = await firstCursor(repo);
      const tampered = `${token.slice(0, 10)}${token[10] === 'A' ? 'B' : 'A'}${token.slice(11)}`;
      for (const bad of [tampered, token.slice(0, token.length - 5), 'not-a-cursor']) {
        let caught: { status?: number; code?: string } = {};
        try {
          await repo.getAll({ sort: { name: 1 }, limit: 3, after: bad });
        } catch (err) {
          caught = err as typeof caught;
        }
        expect(caught.status, bad).toBe(400);
        expect(caught.code, bad).toBe(PAGINATION_ERROR_CODES.CURSOR_INVALID);
      }
    });

    it('a cursor replayed against another filter, tenant, collection or collation is refused', async () => {
      const token = await firstCursor(repo, { filters: { status: 'open' } });
      expect(await codeOf(repo.getAll({ sort: { name: 1 }, limit: 3, after: token, filters: { status: 'paid' } }))).toBe(
        PAGINATION_ERROR_CODES.CURSOR_SCOPE_MISMATCH,
      );
      const tenantToken = await firstCursor(scoped, { organizationId: 'org-a' });
      expect(
        await codeOf(scoped.getAll({ sort: { name: 1 }, limit: 3, after: tenantToken, organizationId: 'org-b' })),
      ).toBe(PAGINATION_ERROR_CODES.CURSOR_SCOPE_MISMATCH);
      const plain = await firstCursor(repo);
      expect(await codeOf(new Repository<IRow>(Other).getAll({ sort: { name: 1 }, limit: 3, after: plain }))).toBe(
        PAGINATION_ERROR_CODES.CURSOR_SCOPE_MISMATCH,
      );
      expect(
        await codeOf(repo.getAll({ sort: { name: 1 }, limit: 3, after: plain, collation: { locale: 'en', strength: 2 } })),
      ).toBe(PAGINATION_ERROR_CODES.CURSOR_SCOPE_MISMATCH);
    });

    it('the same cursor with the same scope still pages', async () => {
      const token = await firstCursor(scoped, { organizationId: 'org-a' });
      const next = (await scoped.getAll({ sort: { name: 1 }, limit: 3, after: token, organizationId: 'org-a' })) as Page;
      expect(next.data).toHaveLength(3);
    });
  });

  describe('keyset over null / missing and Decimal128 keys', () => {
    /** Walk every keyset page; BSON order puts null and missing first ascending, last descending. */
    async function walk(sort: Record<string, 1 | -1>): Promise<IRow[]> {
      const out: IRow[] = [];
      let after: string | undefined;
      for (let i = 0; i < 40; i++) {
        const page = (await repo.getAll({ sort, limit: 4, mode: 'keyset', ...(after ? { after } : {}) })) as Page;
        out.push(...page.data);
        if (!page.next) break;
        after = page.next;
      }
      return out;
    }
    const all = async () => Row.find({}).lean<IRow[]>();
    const key = (r: IRow) => (r.rank === undefined || r.rank === null ? Number.NEGATIVE_INFINITY : r.rank);

    for (const dir of [1, -1] as const) {
      it(`rank ${dir === 1 ? 'ascending' : 'descending'} returns every row once, in BSON order`, async () => {
        const rows = await walk({ rank: dir });
        expect(rows).toHaveLength(30);
        expect(new Set(rows.map((r) => r.name)).size).toBe(30);
        const ranks = rows.map(key);
        const expected = (await all()).map(key).sort((a, b) => (a - b) * dir);
        expect(ranks).toEqual(expected);
      });
    }

    it('a Decimal128 sort key round-trips through the cursor', async () => {
      const rows = await walk({ price: 1 });
      expect(rows).toHaveLength(30);
      const prices = rows.map((r) => Number(String(r.price)));
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
    });

    it('a Decimal128 key round-trips through the aggregate keyset (no query casting there)', async () => {
      const names: string[] = [];
      let after: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = (await repo.lookupPopulate({
          filters: {},
          lookups: [],
          sort: { price: 1 },
          limit: 4,
          ...(after ? { after } : {}),
        })) as Page;
        names.push(...page.data.map((d) => d.name));
        if (!page.next) break;
        after = page.next;
      }
      expect(new Set(names).size).toBe(30);
    });

    it('a compound mixed-direction sort with ties pages completely', async () => {
      const rows = await walk({ status: 1, rank: -1 });
      expect(new Set(rows.map((r) => r.name)).size).toBe(30);
    });
  });

  describe('count shape and strategies', () => {
    it('every strategy reports { total, totalIsEstimate, countedAt }', async () => {
      const exact = (await repo.getAll({ page: 1, limit: 5, countStrategy: 'exact' })) as Record<string, unknown>;
      expect(exact).toMatchObject({ total: 30, totalIsEstimate: false });
      expect(exact.countedAt).toBeInstanceOf(Date);
      const capped = (await repo.getAll({ page: 1, limit: 5, countStrategy: 'capped', countLimit: 10 })) as Record<string, unknown>;
      expect(capped).toMatchObject({ total: 10, totalIsEstimate: true });
      const none = (await repo.getAll({ page: 1, limit: 5, countStrategy: 'none' })) as Record<string, unknown>;
      expect(none).toMatchObject({ totalIsEstimate: true, countedAt: null });
      const est = (await repo.getAll({ page: 1, limit: 5, countStrategy: 'estimated' })) as Record<string, unknown>;
      expect(est).toMatchObject({ total: 30, totalIsEstimate: true });
    });

    it("'cached' counts once per TTL per scope and reports when it counted", async () => {
      configurePaginationDefaults({ defaultCountStrategy: 'cached', countCacheTtlMs: 60_000 });
      const cached = new Repository<IRow>(Row);
      const first = await recordCommands(conn, () => cached.getAll({ filters: { status: 'open' }, page: 1, limit: 5 }));
      const second = await recordCommands(conn, () => cached.getAll({ filters: { status: 'open' }, page: 2, limit: 5 }));
      const other = await recordCommands(conn, () => cached.getAll({ filters: { status: 'paid' }, page: 1, limit: 5 }));
      const counts = (r: { commands: RecordedCommand[] }) =>
        r.commands.filter((c) => c.collection === coll() && c.name === 'aggregate').length;
      expect(counts(first)).toBe(1);
      expect(counts(second)).toBe(0);
      expect(counts(other)).toBe(1);
      const a = first.result as Record<string, unknown>;
      const b = second.result as Record<string, unknown>;
      expect(a).toMatchObject({ total: 15, totalIsEstimate: true });
      expect(b.countedAt).toEqual(a.countedAt);
    });

    it('the count carries the tenant + soft-delete scope, hint and maxTimeMS of the page', async () => {
      await Row.collection.createIndex({ status: 1 }, { name: 'pag_status' });
      const { commands } = await recordCommands(conn, () =>
        scoped.getAll({ filters: { status: 'open' }, page: 1, limit: 5, organizationId: 'org-a', hint: 'pag_status', maxTimeMS: 1234, countStrategy: 'exact' }),
      );
      const count = on(commands, 'aggregate')[0];
      const match = JSON.stringify(count?.command.pipeline);
      expect(match).toContain('org-a');
      expect(match).toContain('deletedAt');
      expect(count?.command.hint).toBe('pag_status');
      expect(count?.command.maxTimeMS).toBe(1234);
    });
  });

  describe('aggregate pages keep memory bounded', () => {
    it('lookupPopulate pages with two commands and no $facet', async () => {
      const { result, commands } = await recordCommands(conn, () =>
        repo.lookupPopulate({ filters: { status: 'open' }, lookups: [], page: 1, limit: 5 }),
      );
      const aggs = on(commands, 'aggregate');
      expect(JSON.stringify(aggs.map((a) => a.command.pipeline))).not.toContain('$facet');
      expect((result as { total: number }).total).toBe(15);
    });
  });
});
