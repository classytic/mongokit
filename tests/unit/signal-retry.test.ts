/**
 * `QueryOptions.signal` + `QueryOptions.retryPolicy` — the repo-core
 * 0.6.0 resilience contract on the main CRUD surface.
 *
 * Locked-in semantics:
 *   1. A pre-aborted signal rejects BEFORE any driver call (and before
 *      before-hooks — the guard sits in `_buildContext`).
 *   2. `retryPolicy` retries a transiently-failing driver call to
 *      success with exponential backoff.
 *   3. Retries re-run ONLY the driver round-trip — before-hooks
 *      (validation, tenant scope, audit, events) never fire twice.
 *   4. Aborting during retry backoff stops further attempts.
 *
 * Uses a chainable mock model — no mongo needed (driver behavior is
 * scripted per test).
 */

import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { Repository } from '../../src/Repository.js';

interface MockHarness {
  model: Model<Record<string, unknown>>;
  execMock: ReturnType<typeof vi.fn>;
  findOneMock: ReturnType<typeof vi.fn>;
  ctorMock: ReturnType<typeof vi.fn>;
}

/** Chainable findOne query + constructible model (for create's `new Model()`). */
function mockModel(name = 'SignalRetryDoc'): MockHarness {
  const execMock = vi.fn().mockResolvedValue({ _id: '1', name: 'ok' });
  const query = {
    select: vi.fn().mockReturnThis(),
    populate: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    session: vi.fn().mockReturnThis(),
    read: vi.fn().mockReturnThis(),
    exec: execMock,
  };
  const findOneMock = vi.fn().mockReturnValue(query);

  const ctorMock = vi.fn().mockImplementation(function (data: Record<string, unknown>) {
    return {
      ...data,
      _id: '1',
      save: vi.fn().mockResolvedValue(undefined),
    };
  });
  Object.assign(ctorMock, {
    modelName: name,
    schema: { indexes: () => [], obj: {}, paths: {} },
    findOne: findOneMock,
  });

  return {
    model: ctorMock as unknown as Model<Record<string, unknown>>,
    execMock,
    findOneMock,
    ctorMock,
  };
}

describe('QueryOptions.signal — abort at the op boundary', () => {
  it('a pre-aborted signal rejects getByQuery before any driver call', async () => {
    const { model, findOneMock, execMock } = mockModel();
    const repo = new Repository(model);

    const ac = new AbortController();
    ac.abort(new Error('cancelled-before-call'));

    await expect(repo.getByQuery({ name: 'x' }, { signal: ac.signal })).rejects.toThrow(
      'cancelled-before-call',
    );
    expect(findOneMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('a pre-aborted signal rejects create before the model constructor runs', async () => {
    const { model, ctorMock } = mockModel();
    const repo = new Repository(model);

    const ac = new AbortController();
    ac.abort(new Error('cancelled-before-create'));

    await expect(repo.create({ name: 'x' }, { signal: ac.signal })).rejects.toThrow(
      'cancelled-before-create',
    );
    expect(ctorMock).not.toHaveBeenCalled();
  });

  it('a pre-aborted signal rejects before before-hooks run (guard sits in _buildContext)', async () => {
    const { model } = mockModel();
    const repo = new Repository(model);
    const beforeHook = vi.fn();
    repo.on('before:getByQuery', beforeHook);

    const ac = new AbortController();
    ac.abort(new Error('cancelled'));

    await expect(repo.getByQuery({ name: 'x' }, { signal: ac.signal })).rejects.toThrow(
      'cancelled',
    );
    expect(beforeHook).not.toHaveBeenCalled();
  });
});

describe('QueryOptions.retryPolicy — transient-failure retry around the driver call', () => {
  it('retries a transiently-failing driver call to success (2 failures, maxAttempts 3)', async () => {
    const { model, execMock, findOneMock } = mockModel();
    execMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ _id: '1', name: 'recovered' });

    const repo = new Repository(model);
    const result = await repo.getByQuery(
      { name: 'x' },
      { retryPolicy: { maxAttempts: 3, baseDelayMs: 1 } },
    );

    expect(result).toMatchObject({ name: 'recovered' });
    // The driver round-trip (query rebuild + exec) ran 3 times.
    expect(findOneMock).toHaveBeenCalledTimes(3);
    expect(execMock).toHaveBeenCalledTimes(3);
  });

  it('exhausts maxAttempts and surfaces the last error', async () => {
    const { model, execMock } = mockModel();
    execMock.mockRejectedValue(new Error('SQLITE_BUSY-ish persistent failure'));

    const repo = new Repository(model);
    await expect(
      repo.getByQuery({ name: 'x' }, { retryPolicy: { maxAttempts: 3, baseDelayMs: 1 } }),
    ).rejects.toThrow(/persistent failure/);
    expect(execMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT re-run before-hooks on retry — hooks fire once per logical call', async () => {
    const { model, execMock } = mockModel();
    execMock
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ _id: '1', name: 'ok' });

    const repo = new Repository(model);
    const beforeHook = vi.fn();
    const afterHook = vi.fn();
    repo.on('before:getByQuery', beforeHook);
    repo.on('after:getByQuery', afterHook);

    await repo.getByQuery({ name: 'x' }, { retryPolicy: { maxAttempts: 3, baseDelayMs: 1 } });

    expect(execMock).toHaveBeenCalledTimes(3); // driver retried
    expect(beforeHook).toHaveBeenCalledTimes(1); // hooks did not
    expect(afterHook).toHaveBeenCalledTimes(1);
  });

  it('honors shouldRetry — non-transient errors are not retried', async () => {
    const { model, execMock } = mockModel();
    execMock.mockRejectedValue(new Error('ValidationError: not transient'));

    const repo = new Repository(model);
    await expect(
      repo.getByQuery(
        { name: 'x' },
        {
          retryPolicy: {
            maxAttempts: 5,
            baseDelayMs: 1,
            shouldRetry: (err) => /ECONNRESET|WriteConflict/i.test(String(err)),
          },
        },
      ),
    ).rejects.toThrow(/not transient/);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('soft-delete: retryPolicy retries a transiently-failing findOneAndUpdate to success', async () => {
    // The soft-delete write happens INSIDE the before:delete hook (the
    // class-level resilience wrap is skipped once `softDeleted` is set),
    // so the plugin carries its own withRetry around the driver call.
    const { softDeletePlugin } = await import('../../src/plugins/soft-delete.plugin.js');

    const findOneAndUpdateMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('WriteConflict'))
      .mockRejectedValueOnce(new Error('WriteConflict'))
      .mockResolvedValueOnce({ _id: 'doc-1', deletedAt: new Date() });

    const ctorMock = vi.fn();
    Object.assign(ctorMock, {
      modelName: 'SoftDeleteRetryDoc',
      // String _id instance so a plain test id passes shape validation.
      schema: { indexes: () => [], obj: {}, paths: { _id: { instance: 'String' } } },
      findOneAndUpdate: findOneAndUpdateMock,
    });

    const repo = new Repository(ctorMock as unknown as Model<Record<string, unknown>>, [
      softDeletePlugin(),
    ]);
    const beforeHook = vi.fn();
    repo.on('before:delete', beforeHook);

    const result = await repo.delete('doc-1', {
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1 },
    });

    expect(result).toMatchObject({ soft: true, id: 'doc-1' });
    expect(findOneAndUpdateMock).toHaveBeenCalledTimes(3); // driver retried
    expect(beforeHook).toHaveBeenCalledTimes(1); // hooks did not re-run
  });

  it('soft-delete: retryPolicy retries the deleteMany→updateMany conversion too', async () => {
    const { softDeletePlugin } = await import('../../src/plugins/soft-delete.plugin.js');

    const updateManyMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ modifiedCount: 2 });

    const ctorMock = vi.fn();
    Object.assign(ctorMock, {
      modelName: 'SoftDeleteManyRetryDoc',
      schema: { indexes: () => [], obj: {}, paths: { _id: { instance: 'String' } } },
      updateMany: updateManyMock,
    });

    const repo = new Repository(ctorMock as unknown as Model<Record<string, unknown>>, [
      softDeletePlugin(),
    ]);

    const result = await repo.deleteMany(
      { status: 'stale' },
      { retryPolicy: { maxAttempts: 3, baseDelayMs: 1 } },
    );

    expect(result).toMatchObject({ soft: true, deletedCount: 2 });
    expect(updateManyMock).toHaveBeenCalledTimes(2);
  });

  it('abort during retry backoff stops further attempts', async () => {
    const { model, execMock } = mockModel();
    const ac = new AbortController();
    // First attempt fails AND aborts the signal — withRetry checks the
    // signal between attempts (never mid-attempt) and rethrows the abort
    // reason instead of trying again.
    execMock.mockImplementation(() => {
      ac.abort(new Error('cancelled-during-backoff'));
      return Promise.reject(new Error('transient'));
    });

    const repo = new Repository(model);
    await expect(
      repo.getByQuery(
        { name: 'x' },
        { signal: ac.signal, retryPolicy: { maxAttempts: 5, baseDelayMs: 1 } },
      ),
    ).rejects.toThrow(/cancelled-during-backoff/);
    expect(execMock).toHaveBeenCalledTimes(1); // no second attempt
  });
});
