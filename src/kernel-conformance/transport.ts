/**
 * A dependency-free `EventTransport`-shaped bus for the conformance suite, plus the
 * instrumentation used to prove a SUPPLIED transport was not closed.
 *
 * Structurally identical to `@classytic/primitives`' `InProcessEventBus` and arc's
 * `MemoryEventTransport` — deliberately re-implemented (30 lines) rather than imported, so
 * mongokit gains no dependency on either.
 */
import type { ConformanceEvent, EventTransportLike } from './types.js';

type Handler = (event: ConformanceEvent) => unknown;

/** Exact match, `*`, or a `prefix.*` / `prefix:*` glob — the kernel bus convention. */
function matches(pattern: string, type: string): boolean {
  if (pattern === '*' || pattern === type) return true;
  if (pattern.endsWith('.*')) return type.startsWith(`${pattern.slice(0, -1)}`);
  if (pattern.endsWith(':*')) return type.startsWith(`${pattern.slice(0, -1)}`);
  return false;
}

let eventSeq = 0;

/** A minimal, valid domain-event envelope (`type` + `meta.id` is all any bus reads). */
export function conformanceEvent(type: string): ConformanceEvent {
  eventSeq += 1;
  return {
    type,
    payload: {},
    meta: {
      id: `kernel-conformance-${eventSeq}`,
      occurredAt: new Date().toISOString(),
      source: 'kernel-conformance',
    },
  };
}

/** An in-process transport good enough to stand in for a host-owned shared bus. */
export function createConformanceTransport(
  name = 'kernel-conformance-transport',
): EventTransportLike {
  const handlers = new Map<string, Set<Handler>>();
  let closed = false;

  const publish = async (event: ConformanceEvent): Promise<void> => {
    if (closed) return;
    const matched = new Set<Handler>();
    for (const [pattern, set] of handlers) {
      if (matches(pattern, event.type)) for (const h of set) matched.add(h);
    }
    for (const handler of matched) await handler(event);
  };

  return {
    name,
    publish,
    async publishMany(events: readonly ConformanceEvent[]) {
      const results = new Map<string, Error | null>();
      for (const e of events) {
        await publish(e);
        results.set(String(e.meta?.id ?? e.type), null);
      }
      return results;
    },
    async subscribe(pattern: string, handler: Handler) {
      let set = handlers.get(pattern);
      if (!set) {
        set = new Set();
        handlers.set(pattern, set);
      }
      set.add(handler);
      return () => {
        handlers.get(pattern)?.delete(handler);
      };
    },
    async close() {
      closed = true;
      handlers.clear();
    },
  };
}

export interface InstrumentedTransport {
  /** Hand THIS to the kernel. */
  readonly transport: EventTransportLike;
  /** How many times the kernel called `close()` on it. Must stay 0. */
  closeCalls(): number;
}

/**
 * Wrap a transport so `close()` calls are counted. The wrapper forwards everything else, so
 * the kernel cannot tell the difference — which is the point: ownership must be decided by
 * "did I create this?", never by inspecting the object.
 */
export function instrumentTransport(inner: EventTransportLike): InstrumentedTransport {
  let closeCalls = 0;
  const transport: EventTransportLike = {
    name: inner.name ?? 'kernel-conformance-supplied',
    publish: (event) => inner.publish(event),
    ...(inner.publishMany
      ? {
          publishMany: (events: readonly ConformanceEvent[]) =>
            (inner.publishMany as (e: readonly ConformanceEvent[]) => Promise<unknown>)(events),
        }
      : {}),
    ...(inner.subscribe
      ? {
          subscribe: (pattern: string, handler: Handler) =>
            inner.subscribe?.(pattern, handler) as Promise<() => void>,
        }
      : {}),
    close: async () => {
      closeCalls += 1;
      await inner.close?.();
    },
  };
  return { transport, closeCalls: () => closeCalls };
}
