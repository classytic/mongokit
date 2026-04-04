/**
 * Observability Plugin
 *
 * Adds operation timing, structured metrics, and APM hook points.
 * Works with any monitoring system — just provide an onMetric callback.
 *
 * @example
 * ```typescript
 * const repo = new Repository(User, [
 *   observabilityPlugin({
 *     onMetric: (metric) => {
 *       // Send to DataDog, New Relic, OpenTelemetry, or console
 *       console.log(`${metric.operation} took ${metric.durationMs}ms`);
 *       statsd.histogram('mongokit.operation', metric.durationMs, { op: metric.operation });
 *     },
 *   }),
 * ]);
 * ```
 */

import type { Plugin, RepositoryContext, RepositoryInstance } from '../types.js';

export interface OperationMetric {
  /** Operation name (e.g., 'create', 'getAll', 'update') */
  operation: string;
  /** Model/collection name */
  model: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Timestamp when the operation started */
  startedAt: Date;
  /** User ID if available */
  userId?: string;
  /** Organization ID if available */
  organizationId?: string;
}

export interface ObservabilityOptions {
  /** Callback invoked after every operation with timing data */
  onMetric: (metric: OperationMetric) => void;
  /** Operations to track (default: all) */
  operations?: string[];
  /** Threshold in ms — only report operations slower than this */
  slowThresholdMs?: number;
}

const DEFAULT_OPS = [
  'create',
  'createMany',
  'update',
  'delete',
  'getById',
  'getByQuery',
  'getAll',
  'aggregatePaginate',
  'lookupPopulate',
];

// WeakMap avoids memory leaks — entries are GC'd when context is collected
const timers = new WeakMap<RepositoryContext, number>();

export function observabilityPlugin(options: ObservabilityOptions): Plugin {
  const { onMetric, slowThresholdMs } = options;
  const ops = options.operations ?? DEFAULT_OPS;

  return {
    name: 'observability',

    apply(repo: RepositoryInstance): void {
      for (const op of ops) {
        // Start timer — before:* hooks receive context directly
        // Runs at OBSERVABILITY priority (300) — after policy and cache hooks
        repo.on(
          `before:${op}`,
          (context: RepositoryContext) => {
            timers.set(context, performance.now());
          },
          { priority: 300 },
        );

        // Record success
        repo.on(`after:${op}`, ({ context }: { context: RepositoryContext }) => {
          const start = timers.get(context);
          if (start == null) return;

          const durationMs = Math.round((performance.now() - start) * 100) / 100;
          timers.delete(context);

          if (slowThresholdMs != null && durationMs < slowThresholdMs) return;

          onMetric({
            operation: op,
            model: context.model || repo.model,
            durationMs,
            success: true,
            startedAt: new Date(Date.now() - durationMs),
            userId: context.user?._id?.toString() || context.user?.id?.toString(),
            organizationId: context.organizationId?.toString(),
          });
        });

        // Record failure
        repo.on(
          `error:${op}`,
          ({ context, error }: { context: RepositoryContext; error: Error }) => {
            const start = timers.get(context);
            if (start == null) return;

            const durationMs = Math.round((performance.now() - start) * 100) / 100;
            timers.delete(context);

            onMetric({
              operation: op,
              model: context.model || repo.model,
              durationMs,
              success: false,
              error: error.message,
              startedAt: new Date(Date.now() - durationMs),
              userId: context.user?._id?.toString() || context.user?.id?.toString(),
              organizationId: context.organizationId?.toString(),
            });
          },
        );
      }
    },
  };
}
