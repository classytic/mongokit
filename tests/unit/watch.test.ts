/**
 * Unit tests for `Repository.watch()` — the change-feed surface — against
 * a mocked `Model.watch()` returning a fake async-iterable ChangeStream.
 * Real change streams need a replica set; the end-to-end path is covered
 * by tests/integration/watch-change-stream.test.ts.
 */

import type { ChangeEvent } from '@classytic/repo-core/repository';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { Repository } from '../../src/Repository.js';

interface FakeChange {
  operationType: string;
  documentKey?: { _id?: unknown };
  fullDocument?: unknown;
  wallTime?: Date;
}

/**
 * Minimal stand-in for mongoose's ChangeStream wrapper / the driver
 * ChangeStream: an `on`/`removeListener`/`close` event surface. Changes
 * buffered before a `'change'` listener attaches are delivered on
 * subscription (mirrors the driver: the stream starts flowing once a
 * listener is attached).
 */
function createFakeChangeStream(initial: FakeChange[] = []) {
  const pending = [...initial];
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners[event] ?? []) listener(...args);
  };

  const stream = {
    on(event: string, listener: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(listener);
      if (event === 'change') {
        for (const change of pending.splice(0)) listener(change);
      }
      return stream;
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
      return stream;
    },
    close: vi.fn(async () => {
      emit('close');
    }),
    push(change: FakeChange) {
      if (listeners.change?.length) emit('change', change);
      else pending.push(change);
    },
    emitError(error: Error) {
      emit('error', error);
    },
  };
  return stream;
}

function fakeModel(stream: ReturnType<typeof createFakeChangeStream>, name = 'WatchDoc') {
  const watch = vi.fn(() => stream);
  const model = {
    modelName: name,
    schema: { indexes: () => [], obj: {}, paths: {} },
    watch,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Model<Record<string, unknown>>;
  return { model, watch };
}

async function take<T>(iterable: AsyncIterable<T>, count: number): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
    if (out.length >= count) break;
  }
  return out;
}

describe('Repository.watch (mocked change stream)', () => {
  it('maps change-stream documents to portable ChangeEvents', async () => {
    const wallTime = new Date('2026-01-02T03:04:05Z');
    const stream = createFakeChangeStream([
      { operationType: 'insert', documentKey: { _id: 'a' }, fullDocument: { name: 'A' }, wallTime },
      // Unknown operation types (e.g. drop/invalidate) are skipped.
      { operationType: 'invalidate' },
      { operationType: 'update', documentKey: { _id: 'b' }, fullDocument: { name: 'B2' } },
      { operationType: 'replace', documentKey: { _id: 'c' }, fullDocument: { name: 'C2' } },
      { operationType: 'delete', documentKey: { _id: 'd' } },
    ]);
    const { model } = fakeModel(stream);
    const repo = new Repository(model);

    const events = await take(repo.watch(), 4);

    expect(events.map((e) => e.operation)).toEqual(['create', 'update', 'replace', 'delete']);
    expect(events[0]).toMatchObject({ id: 'a', doc: { name: 'A' } });
    expect(events[0].timestamp).toEqual(wallTime);
    expect(events[1].doc).toEqual({ name: 'B2' });
    expect(events[3].id).toBe('d');
    expect(events[3].doc).toBeUndefined(); // deletes carry no post-image
    for (const event of events) expect(event.timestamp).toBeInstanceOf(Date);

    // Early break (take) closes the underlying stream.
    expect(stream.close).toHaveBeenCalled();
  });

  it('compiles the caller filter against fullDocument.* paths and forwards resumeAfter', async () => {
    const stream = createFakeChangeStream();
    const { model, watch } = fakeModel(stream);
    const repo = new Repository(model);
    const resumeToken = { _data: 'token' };

    const ac = new AbortController();
    const consumer = take(
      repo.watch({ status: 'pending' }, { signal: ac.signal, resumeAfter: resumeToken }),
      1,
    );
    // Let the generator start (it builds the stream lazily on first pull).
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await consumer;

    expect(watch).toHaveBeenCalledTimes(1);
    const [pipeline, options] = watch.mock.calls[0] as unknown as [
      Record<string, unknown>[],
      Record<string, unknown>,
    ];
    expect(pipeline[0]).toEqual({
      $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete'] } },
    });
    expect(pipeline[1]).toEqual({ $match: { 'fullDocument.status': 'pending' } });
    expect(options).toMatchObject({ fullDocument: 'updateLookup', resumeAfter: resumeToken });
  });

  it('ends iteration cleanly when options.signal aborts mid-stream', async () => {
    const stream = createFakeChangeStream([
      { operationType: 'insert', documentKey: { _id: '1' }, fullDocument: { n: 1 } },
    ]);
    const { model } = fakeModel(stream);
    const repo = new Repository(model);

    const ac = new AbortController();
    const seen: ChangeEvent[] = [];
    const consumer = (async () => {
      for await (const event of repo.watch(undefined, { signal: ac.signal })) {
        seen.push(event as ChangeEvent);
      }
    })();

    // Allow the first (buffered) event through, then abort while the
    // iterator is parked waiting for the next change.
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    ac.abort();

    await expect(consumer).resolves.toBeUndefined(); // clean end, no throw
    expect(stream.close).toHaveBeenCalled();
  });

  it('rejects at the op boundary when the signal is already aborted (no stream opened)', async () => {
    const stream = createFakeChangeStream([
      { operationType: 'insert', documentKey: { _id: '1' }, fullDocument: { n: 1 } },
    ]);
    const { model, watch } = fakeModel(stream);
    const repo = new Repository(model);

    const ac = new AbortController();
    ac.abort(new Error('cancelled-before-watch'));

    // watch() routes through _buildContext, which carries the same
    // pre-abort guard as every other op — the rejection fires BEFORE
    // Model.watch is ever called.
    await expect(take(repo.watch(undefined, { signal: ac.signal }), 1)).rejects.toThrow(
      'cancelled-before-watch',
    );
    expect(watch).not.toHaveBeenCalled();
  });

  it('propagates stream errors to the consumer when not aborted', async () => {
    const stream = createFakeChangeStream();
    const { model } = fakeModel(stream);
    const repo = new Repository(model);

    const consumer = take(repo.watch(), 1);
    await new Promise((r) => setImmediate(r));
    // Emit a stream error WITHOUT an abort — it must surface to the consumer.
    stream.emitError(new Error('ChangeStream getMore failed'));

    await expect(consumer).rejects.toThrow('ChangeStream getMore failed');
  });

  it('ends iteration when the stream closes server-side', async () => {
    const stream = createFakeChangeStream([
      { operationType: 'insert', documentKey: { _id: '1' }, fullDocument: { n: 1 } },
    ]);
    const { model } = fakeModel(stream);
    const repo = new Repository(model);

    const consumer = (async () => {
      const seen: ChangeEvent[] = [];
      for await (const event of repo.watch()) seen.push(event as ChangeEvent);
      return seen;
    })();

    await new Promise((r) => setImmediate(r));
    await stream.close();

    await expect(consumer).resolves.toHaveLength(1);
  });
});

describe('Repository.watch — policy-hook routing (before:watch)', () => {
  /** Drive watch() far enough to capture the pipeline, then abort. */
  async function capturePipeline(
    repo: Repository<Record<string, unknown>>,
    watch: ReturnType<typeof vi.fn>,
    filter?: Record<string, unknown>,
    extraOptions: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> {
    const ac = new AbortController();
    const consumer = take(
      repo.watch(filter, {
        signal: ac.signal,
        ...extraOptions,
      } as import('@classytic/repo-core/repository').WatchOptions),
      1,
    );
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await consumer;
    expect(watch).toHaveBeenCalledTimes(1);
    return watch.mock.calls[0][0] as unknown as Record<string, unknown>[];
  }

  it('multiTenantPlugin scopes the change-stream pipeline to the tenant (fullDocument paths)', async () => {
    const stream = createFakeChangeStream();
    const { model, watch } = fakeModel(stream, 'WatchTenantDoc');
    const { multiTenantPlugin } = await import('../../src/plugins/multi-tenant.plugin.js');
    const repo = new Repository(model, [
      multiTenantPlugin({ tenantField: 'organizationId', required: true }),
    ]);

    const pipeline = await capturePipeline(repo, watch, undefined, {
      organizationId: 'org_watch',
    });

    expect(pipeline[1]).toEqual({
      $match: { 'fullDocument.organizationId': 'org_watch' },
    });
  });

  it('throws (before opening any stream) when the tenant is missing under required: true', async () => {
    const stream = createFakeChangeStream();
    const { model, watch } = fakeModel(stream, 'WatchTenantMissingDoc');
    const { multiTenantPlugin } = await import('../../src/plugins/multi-tenant.plugin.js');
    const repo = new Repository(model, [
      multiTenantPlugin({ tenantField: 'organizationId', required: true }),
    ]);

    await expect(take(repo.watch({ status: 'pending' }), 1)).rejects.toThrow(
      /Missing 'organizationId'/,
    );
    expect(watch).not.toHaveBeenCalled(); // required-tenant throw fires first
  });

  it('softDeletePlugin injects the deletion-state predicate into the pipeline', async () => {
    const stream = createFakeChangeStream();
    const { model, watch } = fakeModel(stream, 'WatchSoftDeleteDoc');
    const { softDeletePlugin } = await import('../../src/plugins/soft-delete.plugin.js');
    const repo = new Repository(model, [softDeletePlugin()]);

    const pipeline = await capturePipeline(repo, watch);

    expect(pipeline[1]).toEqual({
      $match: { 'fullDocument.deletedAt': null },
    });
  });

  it('caller filter and policy predicates COMPOSE in the same $match', async () => {
    const stream = createFakeChangeStream();
    const { model, watch } = fakeModel(stream, 'WatchComposeDoc');
    const { multiTenantPlugin } = await import('../../src/plugins/multi-tenant.plugin.js');
    const { softDeletePlugin } = await import('../../src/plugins/soft-delete.plugin.js');
    const repo = new Repository(model, [
      multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      softDeletePlugin(),
    ]);

    const pipeline = await capturePipeline(
      repo,
      watch,
      { status: 'pending' },
      { organizationId: 'org_compose' },
    );

    expect(pipeline[1]).toEqual({
      $match: {
        'fullDocument.status': 'pending',
        'fullDocument.organizationId': 'org_compose',
        'fullDocument.deletedAt': null,
      },
    });
  });
});
