/**
 * `runTransaction` / `withTransaction` refuse a session that lacks the surface they drive, with a
 * closed code naming the missing methods, before calling anything on it.
 */

import { describe, expect, it, vi } from 'vitest';
import { runTransaction, TRANSACTION_ERROR_CODES, withTransaction } from '../../src/index.js';

const full = () => ({
  startTransaction: vi.fn(),
  commitTransaction: vi.fn(async () => undefined),
  abortTransaction: vi.fn(async () => undefined),
  inTransaction: vi.fn(() => true),
  endSession: vi.fn(async () => undefined),
});

describe('transaction session surface', () => {
  it('runTransaction refuses a session without startTransaction and calls nothing', async () => {
    const { startTransaction: _drop, ...partial } = full();
    const callback = vi.fn(async () => 'x');
    const err = await runTransaction(partial as never, callback).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: TRANSACTION_ERROR_CODES.SESSION_INCOMPLETE,
      meta: { missing: ['startTransaction'] },
    });
    expect(callback).not.toHaveBeenCalled();
    expect(partial.commitTransaction).not.toHaveBeenCalled();
    expect(partial.abortTransaction).not.toHaveBeenCalled();
  });

  it('withTransaction names every missing method (endSession included), ends what it can, and never falls back', async () => {
    const { commitTransaction: _c, endSession: _e, ...partial } = full();
    const callback = vi.fn(async () => 'x');
    const err = await withTransaction({ startSession: async () => partial as never }, callback, {
      allowFallback: true,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: TRANSACTION_ERROR_CODES.SESSION_INCOMPLETE,
      meta: { missing: ['commitTransaction', 'endSession'] },
    });
    expect(callback).not.toHaveBeenCalled();
    expect(partial.startTransaction).not.toHaveBeenCalled();
  });

  it('a full session passes the check', async () => {
    const s = full();
    s.inTransaction.mockReturnValueOnce(true).mockReturnValue(true);
    await expect(runTransaction(s as never, async () => 'ok')).resolves.toBe('ok');
    expect(s.startTransaction).toHaveBeenCalledTimes(1);
  });
});
