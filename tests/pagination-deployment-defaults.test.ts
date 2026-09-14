/**
 * Deployment-wide pagination policy.
 *
 * The case that motivates it: a kernel-composed host never constructs the
 * repositories its engines build, so a per-repository `PaginationConfig` is
 * unreachable and every list endpoint inherits `countStrategy: 'exact'` — a
 * `countDocuments` walking every matching index key, on every page, of a page
 * the user reads fifteen rows of.
 *
 * What has to hold:
 *   • a repository built with NO config follows the policy,
 *   • a repository built BEFORE the policy was set follows it too (ordering at
 *     boot must not be load-bearing),
 *   • an explicit per-repository or per-call value still wins,
 *   • and the library default is unchanged for anyone who sets nothing.
 */

import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  configurePaginationDefaults,
  getPaginationDefaults,
  Repository,
  resetPaginationDefaults,
} from '../src/index.js';
import { connectDB, disconnectDB } from './setup.js';

interface IRow {
  _id: Types.ObjectId;
  name: string;
  createdAt: Date;
}

const RowSchema = new Schema<IRow>({
  name: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

let Model: mongoose.Model<IRow>;

beforeAll(async () => {
  await connectDB();
  Model = mongoose.model<IRow>('DeploymentDefaultsRow', RowSchema);
});

afterAll(async () => {
  await disconnectDB();
});

beforeEach(async () => {
  await Model.deleteMany({});
  await Model.insertMany(
    Array.from({ length: 25 }, (_, i) => ({
      name: `row-${i}`,
      createdAt: new Date(2026, 0, i + 1),
    })),
  );
});

afterEach(() => {
  // A global that a test leaves set is a global that fails the next file.
  resetPaginationDefaults();
});

describe('configurePaginationDefaults', () => {
  it('leaves the library default alone until something configures it', async () => {
    const repo = new Repository<IRow>(Model, []);
    expect(getPaginationDefaults()).toEqual({});
    const page = await repo._pagination.paginate({ page: 1, limit: 10 });
    expect(page.total).toBe(25);
    expect(page.pages).toBe(3);
  });

  it('reaches a repository that was given NO config — the kernel-built case', async () => {
    const repo = new Repository<IRow>(Model, []);
    configurePaginationDefaults({ defaultCountStrategy: 'none' });

    const page = await repo._pagination.paginate({ page: 1, limit: 10 });
    // No count ran: `total`/`pages` report 0 and `hasNext` comes from the
    // limit+1 peek instead.
    expect(page.total).toBe(0);
    expect(page.pages).toBe(0);
    expect(page.hasNext).toBe(true);
    expect(page.data).toHaveLength(10);
  });

  it('applies to a repository constructed BEFORE the policy was set', async () => {
    // Boot order must not decide behaviour: engines are often built while the
    // host is still reading its environment.
    const early = new Repository<IRow>(Model, []);
    const before = await early._pagination.paginate({ page: 1, limit: 10 });
    expect(before.total).toBe(25);

    configurePaginationDefaults({ defaultCountStrategy: 'none' });
    const after = await early._pagination.paginate({ page: 1, limit: 10 });
    expect(after.total).toBe(0);
    expect(after.hasNext).toBe(true);
  });

  it('never overrides a repository that asked for a strategy', async () => {
    const explicit = new Repository<IRow>(Model, [], { defaultCountStrategy: 'exact' });
    configurePaginationDefaults({ defaultCountStrategy: 'none' });
    const page = await explicit._pagination.paginate({ page: 1, limit: 10 });
    expect(page.total).toBe(25);
  });

  it('never overrides a single call', async () => {
    const repo = new Repository<IRow>(Model, []);
    configurePaginationDefaults({ defaultCountStrategy: 'none' });
    const page = await repo._pagination.paginate({ page: 1, limit: 10, countStrategy: 'exact' });
    expect(page.total).toBe(25);
  });

  it('merges successive calls instead of clobbering', () => {
    configurePaginationDefaults({ defaultCountStrategy: 'none' });
    configurePaginationDefaults({ maxPage: 50 });
    expect(getPaginationDefaults()).toEqual({ defaultCountStrategy: 'none', maxPage: 50 });
  });

  it('treats an explicit `undefined` as "not specified", not as a reset', () => {
    // A host building this from optional env vars passes `undefined` for the
    // ones it did not set; that must not unset what another call configured.
    configurePaginationDefaults({ defaultCountStrategy: 'none' });
    configurePaginationDefaults({ defaultCountStrategy: undefined, maxPage: 50 });
    expect(getPaginationDefaults().defaultCountStrategy).toBe('none');
  });

  it('carries maxPage, which bounds the OTHER half of the offset cost', async () => {
    const repo = new Repository<IRow>(Model, []);
    configurePaginationDefaults({ maxPage: 2 });
    // `skip(n)` walks n index entries before returning anything, so an
    // unbounded page number is an unbounded read. Refusing is the point.
    await expect(repo._pagination.paginate({ page: 3, limit: 10 })).rejects.toThrow(
      /exceeds maximum 2/,
    );
  });

  it('refuses a too-deep page as a CALLER error, not a server error', async () => {
    const repo = new Repository<IRow>(Model, []);
    configurePaginationDefaults({ maxPage: 2 });
    // The page number arrives in a querystring, so a crawler walking past the
    // end must not become a 500 and an on-call page. This threw a bare `Error`
    // — no status — and every framework above mapped it to internal_error.
    const err = await repo._pagination
      .paginate({ page: 3, limit: 10 })
      .then(() => null)
      .catch((e: unknown) => e as { status?: number; code?: string; meta?: unknown });
    expect(err?.status).toBe(400);
    expect(err?.code).toBe('PAGE_OUT_OF_RANGE');
    expect(err?.meta).toMatchObject({ page: 3, maxPage: 2 });
  });

  /**
   * The policy must live on `globalThis` under a registered symbol, not in a
   * module `let`. A module binding is per MODULE INSTANCE, and this package can
   * appear twice in one graph (an engine pinning an older minor, a pnpm layout
   * that duplicates on a peer, an ESM/CJS dual load). The host would configure
   * its copy while the repositories an engine built read the other copy's empty
   * object — the feature silently doing nothing in exactly the composition it
   * exists for.
   *
   * A second copy cannot be loaded inside one test, so this asserts the
   * mechanism instead: the value is reachable through the shared slot, which is
   * the only thing a second copy needs in order to see it.
   */
  it('keeps the policy on a shared globalThis slot, not a module-local binding', () => {
    const SLOT = Symbol.for('classytic.mongokit.paginationDefaults');
    configurePaginationDefaults({ defaultCountStrategy: 'none' });

    const shared = (globalThis as Record<symbol, unknown>)[SLOT] as
      | { defaultCountStrategy?: string }
      | undefined;
    expect(shared?.defaultCountStrategy).toBe('none');

    // And the reverse direction: a write through the slot — which is what a
    // SECOND copy of this module would do — is seen by this copy's reader.
    (shared as Record<string, unknown>).maxPage = 25;
    expect(getPaginationDefaults().maxPage).toBe(25);
  });

  it('hands out a COPY — a caller cannot mutate the policy through the getter', () => {
    configurePaginationDefaults({ maxPage: 50 });
    (getPaginationDefaults() as { maxPage?: number }).maxPage = 999;
    expect(getPaginationDefaults().maxPage).toBe(50);
  });

  it('resets to library behaviour', async () => {
    const repo = new Repository<IRow>(Model, []);
    configurePaginationDefaults({ defaultCountStrategy: 'none' });
    resetPaginationDefaults();
    const page = await repo._pagination.paginate({ page: 1, limit: 10 });
    expect(page.total).toBe(25);
  });
});
