/**
 * `Repository.watch()` must not buffer without a bound.
 *
 * A change feed has no backpressure: the server pushes, and this bridge holds
 * whatever the consumer has not reached. Unbounded, a consumer merely SLOWER
 * than the write rate is unbounded memory growth — and the symptom, an OOM,
 * appears nowhere near the cause.
 *
 * The contract chosen here, and what each test pins:
 *
 *  - bounded by default, so the failure mode is unreachable without opting in;
 *  - overflow FAILS rather than dropping, because a feed quietly missing a
 *    delete is a reconciliation mystery months later;
 *  - the failure carries the last delivered resume token as DATA, so a
 *    supervisor can restart from a known position instead of parsing prose;
 *  - draining is O(1) per event — `shift()` on a real array is O(n), which
 *    made a backlog quadratic exactly when the process was already struggling.
 */

import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { Repository } from '../../src/Repository.js';

interface FakeChange {
  operationType: string;
  documentKey?: { _id?: unknown };
  fullDocument?: unknown;
  _id?: unknown;
}

function createFakeChangeStream() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners[event] ?? []) listener(...args);
  };
  const stream = {
    on(event: string, listener: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(listener);
      return stream;
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
      return stream;
    },
    close: vi.fn(async () => emit('close')),
    /** Push without waiting for the consumer — the producer-faster-than-consumer case. */
    push(change: FakeChange) {
      emit('change', change);
    },
    get attached() {
      return (listeners.change ?? []).length > 0;
    },
  };
  return stream;
}

function fakeModel(stream: ReturnType<typeof createFakeChangeStream>) {
  return {
    modelName: 'BackpressureDoc',
    schema: { indexes: () => [], obj: {}, paths: {} },
    watch: vi.fn(() => stream),
  } as unknown as Model<Record<string, unknown>>;
}

const change = (n: number): FakeChange => ({
  operationType: 'insert',
  documentKey: { _id: n },
  fullDocument: { n },
  _id: { token: n },
});

/**
 * Start the iterator and wait until it has actually attached its `change`
 * listener.
 *
 * `watch()` awaits `_buildContext` (policy hooks, abort guard) before it
 * subscribes, so a fixed tick is a race: an event pushed too early is emitted
 * to nobody and the iterator then waits forever. Poll the real signal instead.
 */
async function startIdle(
  stream: ReturnType<typeof createFakeChangeStream>,
  iterator: AsyncIterator<unknown>,
): Promise<{ first: Promise<IteratorResult<unknown>> }> {
  const first = iterator.next();
  for (let i = 0; i < 1000 && !stream.attached; i++) {
    await new Promise((r) => setImmediate(r));
  }
  if (!stream.attached) throw new Error('watch() never attached a change listener');
  // WRAPPED, never returned bare: `await` unwraps a returned promise, so
  // `await startIdle(...)` would block on an event the caller has not pushed
  // yet — a deadlock in the harness that looks exactly like a hung iterator.
  return { first };
}

describe('the buffer is bounded', () => {
  it('ends the stream with an error once the consumer falls too far behind', async () => {
    const stream = createFakeChangeStream();
    const repo = new Repository(fakeModel(stream));
    const iterator = repo.watch(undefined, { maxBufferedEvents: 4 })[Symbol.asyncIterator]();

    // Take one event so the iterator is running but then stops consuming.
    const { first } = await startIdle(stream, iterator);
    stream.push(change(0));
    await first;

    // Now flood it well past the bound while nobody reads.
    for (let i = 1; i <= 50; i++) stream.push(change(i));

    // Drain until it throws — the events already buffered are still delivered
    // first, because overflow never discards what was accepted.
    const seen: number[] = [];
    await expect(
      (async () => {
        for (let i = 0; i < 100; i++) {
          const r = await iterator.next();
          if (r.done) break;
          seen.push((r.value as { doc: { n: number } }).doc.n);
        }
      })(),
    ).rejects.toThrow(/fell more than 4 events behind/i);

    // Everything accepted was handed over — nothing silently vanished.
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('checkpoints the ACKNOWLEDGED event, not the one still being processed', async () => {
    /**
     * The distinction between at-least-once and silent loss.
     *
     * The consumer takes event 0, and while it is STILL PROCESSING it the
     * buffer overflows. If the error checkpointed the last DELIVERED event, a
     * supervisor resuming from it would skip event 0 — handed over, never
     * finished, never seen again. Checkpointing the last acknowledged event
     * redelivers it instead, which an idempotent consumer absorbs.
     *
     * Redelivering costs a duplicate; skipping costs a lost write. For money,
     * inventory and outbox consumers those are not comparable.
     */
    const stream = createFakeChangeStream();
    const repo = new Repository(fakeModel(stream));
    const iterator = repo.watch(undefined, { maxBufferedEvents: 2 })[Symbol.asyncIterator]();

    const { first } = await startIdle(stream, iterator);
    stream.push(change(0));
    const delivered = await first;
    expect((delivered.value as { doc: { n: number } }).doc.n).toBe(0);

    // The consumer has event 0 in hand and has NOT come back for the next one.
    // Overflow arrives now.
    for (let i = 1; i <= 20; i++) stream.push(change(i));

    let caught: unknown;
    try {
      for (let i = 0; i < 50; i++) {
        const r = await iterator.next();
        if (r.done) break;
      }
    } catch (err) {
      caught = err;
    }

    const err = caught as { resumeToken?: unknown; deliveredToken?: unknown };
    // Event 0 was delivered but never acknowledged, so it is NOT a safe
    // checkpoint — nothing had completed when the flood began.
    expect(err.deliveredToken).toEqual({ token: 0 });
    expect(err.resumeToken).toBeUndefined();
  });

  it('advances the checkpoint only as the consumer comes back for more', async () => {
    const stream = createFakeChangeStream();
    const repo = new Repository(fakeModel(stream));
    const iterator = repo.watch(undefined, { maxBufferedEvents: 3 })[Symbol.asyncIterator]();

    const { first } = await startIdle(stream, iterator);
    stream.push(change(0));
    await first;
    // Coming back for event 1 is what acknowledges event 0.
    stream.push(change(1));
    await iterator.next();
    stream.push(change(2));
    await iterator.next();

    // Consumer is now holding event 2, having acknowledged 0 and 1.
    for (let i = 3; i <= 30; i++) stream.push(change(i));

    let caught: unknown;
    try {
      for (let i = 0; i < 60; i++) {
        const r = await iterator.next();
        if (r.done) break;
      }
    } catch (err) {
      caught = err;
    }

    const err = caught as { resumeToken?: { token: number }; deliveredToken?: { token: number } };
    // Whatever the checkpoint is, it must never run ahead of what was handed
    // over — that is the invariant, independent of how many events drained
    // before the buffer filled.
    expect(err.resumeToken).toBeDefined();
    expect(err.resumeToken?.token).toBeLessThan((err.deliveredToken as { token: number }).token + 1);
  });

  it('carries the last delivered resume token as data, not prose', async () => {
    const stream = createFakeChangeStream();
    const repo = new Repository(fakeModel(stream));
    const iterator = repo.watch(undefined, { maxBufferedEvents: 2 })[Symbol.asyncIterator]();

    const { first } = await startIdle(stream, iterator);
    stream.push(change(0));
    await first;
    for (let i = 1; i <= 20; i++) stream.push(change(i));

    let caught: unknown;
    try {
      for (let i = 0; i < 50; i++) {
        const r = await iterator.next();
        if (r.done) break;
      }
    } catch (err) {
      caught = err;
    }

    // A supervisor restarts from this, so it must be readable without parsing
    // the message. The consumer drained past event 0 here, so it IS
    // acknowledged by the time the flood lands.
    expect((caught as { deliveredToken?: unknown }).deliveredToken).toBeDefined();
    // mongokit's HttpError carries `status`, not `statusCode`.
    expect((caught as { status?: number }).status).toBe(503);
  });
});

describe('an unusable bound is refused, not read as "no bound"', () => {
  it.each([[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'refuses maxBufferedEvents=%p',
    async (bad) => {
      // Every one of these slips past a `> 0` guard into UNBOUNDED buffering —
      // the failure the option exists to prevent, in a deployment that
      // believed it had set a ceiling.
      const stream = createFakeChangeStream();
      const repo = new Repository(fakeModel(stream));
      const iterator = repo.watch(undefined, { maxBufferedEvents: bad })[Symbol.asyncIterator]();

      await expect(iterator.next()).rejects.toThrow(/positive integer/i);
    },
  );

  it('still accepts 0 — the documented, explicit escape hatch', async () => {
    const stream = createFakeChangeStream();
    const repo = new Repository(fakeModel(stream));
    const iterator = repo.watch(undefined, { maxBufferedEvents: 0 })[Symbol.asyncIterator]();

    const { first } = await startIdle(stream, iterator);
    stream.push(change(0));
    await expect(first).resolves.toBeDefined();
  });
});

describe('an ordinary consumer is unaffected', () => {
  it('delivers every event when the consumer keeps up', async () => {
    const stream = createFakeChangeStream();
    const repo = new Repository(fakeModel(stream));
    const iterator = repo.watch(undefined, { maxBufferedEvents: 4 })[Symbol.asyncIterator]();

    const seen: number[] = [];
    const { first } = await startIdle(stream, iterator);
    stream.push(change(0));
    seen.push(((await first).value as { doc: { n: number } }).doc.n);

    // One at a time, consumed immediately — never more than one buffered.
    for (let i = 1; i <= 200; i++) {
      stream.push(change(i));
      const r = await iterator.next();
      seen.push((r.value as { doc: { n: number } }).doc.n);
    }

    expect(seen).toHaveLength(201);
    expect(seen[200]).toBe(200);
  });

  it('drains a backlog in LINEAR time, not quadratic', async () => {
    /**
     * `queue.shift()` moves every remaining element on each call. Measured
     * standalone at 200k entries: 68 SECONDS versus 2ms for a head index —
     * 34,000x. A backlog therefore became quadratic exactly when the process
     * was already behind, which reads as a hang rather than as slowness.
     *
     * Asserted as a RATIO between two sizes rather than against a millisecond
     * budget, so the test means the same thing on a slow CI box as on a fast
     * laptop: linear doubles when the input doubles, quadratic quadruples.
     * A fixed threshold is what let the first version of this test pass with
     * `shift()` still in place.
     */
    const drain = async (n: number) => {
      const stream = createFakeChangeStream();
      const repo = new Repository(fakeModel(stream));
      const iterator = repo.watch(undefined, { maxBufferedEvents: 0 })[Symbol.asyncIterator]();
      const { first } = await startIdle(stream, iterator);
      stream.push(change(0));
      await first;
      for (let i = 1; i <= n; i++) stream.push(change(i));

      const started = performance.now();
      for (let i = 0; i < n; i++) await iterator.next();
      return performance.now() - started;
    };

    const small = await drain(10_000);
    const large = await drain(20_000);

    // Linear → ~2x. Quadratic → ~4x. Three is the midpoint, and generous
    // enough to absorb GC noise in either run.
    expect(large / Math.max(small, 1)).toBeLessThan(3);
  }, 120_000);

  it('maxBufferedEvents: 0 disables the bound', async () => {
    const stream = createFakeChangeStream();
    const repo = new Repository(fakeModel(stream));
    const iterator = repo.watch(undefined, { maxBufferedEvents: 0 })[Symbol.asyncIterator]();

    const { first } = await startIdle(stream, iterator);
    stream.push(change(0));
    await first;
    for (let i = 1; i <= 5000; i++) stream.push(change(i));

    const r = await iterator.next();
    expect((r.value as { doc: { n: number } }).doc.n).toBe(1);
  });
});
