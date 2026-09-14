/**
 * Cursor signing, end to end through the real `Repository` API.
 *
 * The unit tests prove the codec. These prove the WIRING, which is where a
 * security setting usually dies: a key that is configured but never reaches the
 * code that mints tokens produces unsigned cursors and a deployment that
 * believes otherwise.
 *
 * So each case drives `getAll` and asserts against the token the API actually
 * handed back — including the aggregate keyset path, which is a SECOND cursor
 * codec and therefore a second place to forget.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import {
  configurePaginationDefaults,
  resetPaginationDefaults,
} from '../../src/pagination/defaults.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRow {
  _id?: mongoose.Types.ObjectId;
  n: number;
  salary: number;
}

const SECRET = 'deployment-wide-signing-key';
let Model: mongoose.Model<IRow>;

beforeAll(async () => {
  await connectDB();
  Model = await createTestModel<IRow>(
    'CursorSignRow',
    new mongoose.Schema<IRow>({
      n: { type: Number, required: true },
      salary: { type: Number, required: true },
    }),
  );
});

afterAll(async () => {
  resetPaginationDefaults();
  await disconnectDB();
});

beforeEach(async () => {
  resetPaginationDefaults();
  await Model.deleteMany({});
  await Model.insertMany(
    Array.from({ length: 60 }, (_, i) => ({ n: i, salary: 30_000 + i * 1000 })),
  );
});

const keysetPage = async (repo: Repository<IRow>, opts: Record<string, unknown> = {}) => {
  const r = (await repo.getAll({ sort: { n: 1 }, limit: 10, mode: 'keyset', ...opts })) as unknown as {
    method: string;
    data: IRow[];
    next: string | null;
  };
  if (r.method !== 'keyset') throw new Error('expected a keyset envelope');
  return r;
};

describe('a repository configured with a secret issues signed cursors', () => {
  it('the token the API returns carries a signature', async () => {
    const repo = new Repository<IRow>(Model, [], { cursorSecret: SECRET });
    const p1 = await keysetPage(repo);

    expect(p1.next).toContain('.');
    // And it is still usable — signing must not break paging.
    const p2 = await keysetPage(repo, { after: p1.next });
    expect(p2.data.map((d) => d.n)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('an unsigned repository issues no signature (unchanged default)', async () => {
    const repo = new Repository<IRow>(Model);
    const p1 = await keysetPage(repo);
    expect(p1.next).not.toContain('.');
  });
});

describe('the position cannot be moved by hand', () => {
  it('refuses a cursor whose sort value was edited', async () => {
    const repo = new Repository<IRow>(Model, [], { cursorSecret: SECRET });
    const p1 = await keysetPage(repo);

    // The probing attack: jump the cursor to an arbitrary position to learn
    // where rows above some salary begin.
    const [payload, sig] = (p1.next as string).split('.');
    const edited = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    edited.v = 55;
    const forged = `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${sig}`;

    await expect(keysetPage(repo, { after: forged })).rejects.toThrow(/signature does not verify/i);
  });

  it('refuses the same cursor with its signature stripped', async () => {
    const repo = new Repository<IRow>(Model, [], { cursorSecret: SECRET });
    const p1 = await keysetPage(repo);

    await expect(
      keysetPage(repo, { after: (p1.next as string).split('.')[0] }),
    ).rejects.toThrow(/carries no signature/i);
  });

  it('refuses a bare ObjectId as a position', async () => {
    const repo = new Repository<IRow>(Model, [], { cursorSecret: SECRET });
    const row = await Model.findOne({ n: 30 }).lean();

    await expect(
      keysetPage(repo, { sort: { _id: 1 }, after: String(row?._id) }),
    ).rejects.toThrow(/bare ObjectId is not accepted/i);
  });

  it('a cursor from an UNSIGNED repo is refused by a signed one', async () => {
    const unsigned = await keysetPage(new Repository<IRow>(Model));
    const signed = new Repository<IRow>(Model, [], { cursorSecret: SECRET });

    await expect(keysetPage(signed, { after: unsigned.next })).rejects.toThrow(
      /carries no signature/i,
    );
  });
});

describe('the deployment policy reaches a repository nobody configured', () => {
  it('signs the cursors of a repo built with no config at all', async () => {
    // The composition this seam exists for: a kernel builds the repository, so
    // the host can only reach it globally. Without this, a host would sign its
    // own cursors while every engine-owned list kept issuing unsigned ones.
    const kernelBuilt = new Repository<IRow>(Model);
    configurePaginationDefaults({ cursorSecret: SECRET });

    const p1 = await keysetPage(kernelBuilt);
    expect(p1.next).toContain('.');

    await expect(
      keysetPage(kernelBuilt, { after: (p1.next as string).split('.')[0] }),
    ).rejects.toThrow(/carries no signature/i);
  });
});

describe('the SECOND cursor codec is signed too', () => {
  it('aggregate keyset cursors carry a signature and reject tampering', async () => {
    const repo = new Repository<IRow>(Model, [], { cursorSecret: SECRET });

    const first = (await repo.aggregatePaginate({
      groupBy: ['n'],
      measures: [{ op: 'sum', field: 'salary', as: 'total' }],
      sort: { n: 1 },
      limit: 10,
      pagination: 'keyset',
    })) as { method: string; next?: string | null };

    expect(first.method).toBe('keyset');
    expect(first.next).toContain('.');

    const stripped = (first.next as string).split('.')[0];
    await expect(
      repo.aggregatePaginate({
        groupBy: ['n'],
        measures: [{ op: 'sum', field: 'salary', as: 'total' }],
        sort: { n: 1 },
        limit: 10,
        pagination: 'keyset',
        after: stripped,
      }),
    ).rejects.toThrow(/carries no signature/i);
  });
});
